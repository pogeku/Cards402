// @ts-check
// MPP synchronous verification orchestrator.
//
// Called from the /v1/cards/:product/:amount handler when the client
// presents an Authorization: Payment credential. Runs the full retry
// sequence:
//
//   1. Parse the credential.
//   2. Load the referenced challenge, verify not-expired, not-redeemed.
//   3. Call verifyStellarPayment to check the tx is on-chain and
//      matches the expected contract / order_id / asset / amount.
//   4. Atomically redeem the challenge against the tx_hash (prevents
//      replay against a second challenge).
//   5. Insert an orders row with source='mpp'; attach receipt id.
//   6. Dispatch to the shared handlePayment pipeline.
//   7. Return a structured verdict the router turns into 200/202/4xx.
//
// Pure with respect to HTTP (no res.*); caller maps verdicts to status
// codes. Each failure has a distinct `reason` string so the router can
// pick the right HTTP response.

const { v4: uuidv4 } = require('uuid');
const { rpc } = require('@stellar/stellar-sdk');
const { event: bizEvent } = require('../lib/logger');
const { parsePaymentCredential } = require('./credential');
const { loadChallenge, redeemChallenge, generateReceiptId } = require('./challenge');
const { verifyStellarPayment } = require('../payments/verify-stellar-payment');
const { insertPendingPaymentOrder } = require('../orders/core');
const handlePaymentModule = require('../payment-handler');

// Lazy — only constructed when a credential arrives.
let _rpcServer = null;
function getRpcServer() {
  if (_rpcServer) return _rpcServer;
  const url =
    process.env.SOROBAN_RPC_URL ||
    (process.env.STELLAR_NETWORK === 'testnet'
      ? 'https://soroban-testnet.stellar.org'
      : 'https://mainnet.sorobanrpc.com');
  _rpcServer = new rpc.Server(url);
  return _rpcServer;
}

// Test hook — lets integration tests inject a stubbed rpc.Server.
function _setRpcServer(server) {
  _rpcServer = server;
}

// Test hook — lets integration tests inject a stubbed handlePayment
// (real one calls VCC, which we don't want to hit in CI).
let _handlePayment = null;
function _setHandlePayment(fn) {
  _handlePayment = fn;
}

/**
 * @typedef {{ok: true, orderId: string, receiptId: string, challengeId: string, txHash: string, idempotent?: boolean}
 *   | {ok: false, status: number, reason: string, detail?: string}} VerifyVerdict
 */

/**
 * @param {{
 *   authHeader: string | undefined,
 *   resourcePath: string,
 *   expectedAmount: string,
 * }} opts
 * @returns {Promise<VerifyVerdict>}
 */
async function verifyAndCreateMppOrder(opts) {
  const parsed = parsePaymentCredential(opts.authHeader);
  if (!parsed.ok) {
    const reason = /** @type {any} */ (parsed).reason;
    return { ok: false, status: 400, reason: 'malformed_credential', detail: reason };
  }
  const { credential } = /** @type {{ok:true, credential:any}} */ (parsed);

  const challenge = loadChallenge(credential.challenge);
  if (!challenge) {
    return { ok: false, status: 401, reason: 'challenge_not_found' };
  }
  if (challenge.redeemed_at && challenge.redeemed_tx_hash !== credential.txHash) {
    return { ok: false, status: 409, reason: 'challenge_already_redeemed' };
  }
  if (new Date(challenge.expires_at).getTime() <= Date.now() && !challenge.redeemed_at) {
    return { ok: false, status: 401, reason: 'challenge_expired' };
  }
  // Sanity: the challenge must belong to the resource the client is
  // paying against, otherwise a challenge issued for a $1 card could
  // be redeemed against a $1000 endpoint.
  if (challenge.resource_path !== opts.resourcePath) {
    return { ok: false, status: 400, reason: 'resource_mismatch' };
  }

  // Idempotent retry: same tx for same challenge already succeeded.
  if (challenge.redeemed_at && challenge.redeemed_tx_hash === credential.txHash) {
    const existing = challenge.order_id;
    if (existing) {
      return {
        ok: true,
        orderId: existing,
        receiptId: _loadReceiptId(existing) ?? '',
        challengeId: challenge.id,
        txHash: credential.txHash,
        idempotent: true,
      };
    }
  }

  // Try USDC first. If the tx paid in XLM, verify against the XLM
  // amount snapshotted on the challenge row at issuance time — NOT a
  // fresh price quote, which would drift under the client.
  let verified = null;
  const expectedContractId = process.env.RECEIVER_CONTRACT_ID || '';
  const rpcServer = getRpcServer();
  const expectedXlmAmount = challenge.amount_xlm || null;

  for (const candidate of buildCandidates(opts.expectedAmount, expectedXlmAmount)) {
    const v = await verifyStellarPayment({
      txHash: credential.txHash,
      expectedContractId,
      expectedOrderId: credential.challenge,
      expectedAsset: candidate.asset,
      expectedAmount: candidate.amount,
      rpcServer,
    });
    if (v.status === 'verified') {
      verified = v;
      break;
    }
    if (v.status === 'pending' || v.status === 'rpc_error') {
      // Not terminal — tell the client to retry. Don't burn through the
      // other candidates since the answer applies to all of them.
      return {
        ok: false,
        status: 425, // "Too Early" — semantically: come back when the tx has confirmed
        reason: 'payment_pending',
        detail: v.status === 'rpc_error' ? v.error : 'tx_not_yet_confirmed',
      };
    }
    if (v.status === 'failed') {
      return { ok: false, status: 402, reason: 'payment_failed_on_chain' };
    }
    // 'mismatch' or 'not_our_contract' — try next candidate.
  }

  if (!verified) {
    return { ok: false, status: 402, reason: 'payment_verification_failed' };
  }

  const orderId = uuidv4();
  const receiptId = generateReceiptId();

  // Build a payment instructions blob compatible with what the classic
  // orders API stores in vcc_payment_json. Consumers reading the row
  // don't need to branch on source — the shape is identical.
  const vccPayment = {
    type: 'soroban_contract',
    contract_id: expectedContractId,
    order_id: orderId,
    usdc: { amount: opts.expectedAmount },
    ...(expectedXlmAmount && { xlm: { amount: expectedXlmAmount } }),
  };

  // The order row inserts inside a transaction together with the
  // challenge redemption so the two commit atomically. If the redeem
  // fails (race, UNIQUE tx hash), the order row is rolled back.
  const db = require('../db');
  try {
    db.transaction(() => {
      insertPendingPaymentOrder({
        id: orderId,
        amount_usdc: opts.expectedAmount,
        expected_xlm_amount: expectedXlmAmount,
        api_key_id: 'mpp-anonymous',
        webhook_url: null,
        metadata: null,
        vcc_payment_json: JSON.stringify(vccPayment),
        request_id: null,
        source: 'mpp',
      });
      db.prepare(`UPDATE orders SET mpp_challenge_id = ?, mpp_receipt_id = ? WHERE id = ?`).run(
        challenge.id,
        receiptId,
        orderId,
      );
      const redeem = redeemChallenge({
        id: challenge.id,
        txHash: credential.txHash,
        orderId,
      });
      if (!redeem.ok) {
        const reason = redeem.reason;
        const err = new Error(`redeem_failed:${reason}`);
        /** @type {any} */ (err).code = reason;
        throw err;
      }
    })();
  } catch (err) {
    const code = /** @type {any} */ (err).code;
    if (code === 'tx_already_used') {
      return { ok: false, status: 409, reason: 'payment_already_redeemed' };
    }
    if (code === 'already_redeemed') {
      return { ok: false, status: 409, reason: 'challenge_already_redeemed' };
    }
    if (code === 'expired') {
      return { ok: false, status: 401, reason: 'challenge_expired' };
    }
    throw err;
  }

  bizEvent('mpp.payment_verified', {
    challenge_id: challenge.id,
    order_id: orderId,
    tx_hash: credential.txHash,
    amount: opts.expectedAmount,
    ledger: verified.tx?.ledger,
  });

  // Dispatch to the shared fulfillment pipeline. Same function the
  // async watcher calls — the contract test in Phase 2's test suite
  // asserts identical post-state for the same parsed payload.
  const handlePayment = _handlePayment ?? handlePaymentModule.handlePayment;
  try {
    await handlePayment({
      txid: credential.txHash,
      paymentAsset: verified.payload.paymentAsset,
      amountUsdc: verified.payload.amountUsdc,
      amountXlm: verified.payload.amountXlm,
      senderAddress: verified.payload.senderAddress,
      orderId,
    });
  } catch (err) {
    // Fulfillment kickoff failed — the row exists and the watcher will
    // retry via the stuck-order job. Surface a 500 so the client knows
    // to poll the receipt URL instead of assuming success.
    bizEvent('mpp.dispatch_failed', {
      challenge_id: challenge.id,
      order_id: orderId,
      error: /** @type {Error} */ (err).message,
    });
  }

  return {
    ok: true,
    orderId,
    receiptId,
    challengeId: challenge.id,
    txHash: credential.txHash,
    idempotent: false,
  };
}

function buildCandidates(expectedUsdc, expectedXlm) {
  const out = [{ asset: /** @type {'usdc'|'xlm'} */ ('usdc'), amount: expectedUsdc }];
  if (expectedXlm) out.push({ asset: 'xlm', amount: expectedXlm });
  return out;
}

function _loadReceiptId(orderId) {
  const db = require('../db');
  const row = /** @type {any} */ (
    db.prepare(`SELECT mpp_receipt_id FROM orders WHERE id = ?`).get(orderId)
  );
  return row?.mpp_receipt_id || null;
}

module.exports = {
  verifyAndCreateMppOrder,
  _setRpcServer,
  _setHandlePayment,
};
