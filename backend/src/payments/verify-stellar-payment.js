// @ts-check
// Synchronous Stellar payment verifier.
//
// Given a tx hash the client claims covers a payment, ask Soroban RPC
// "did this tx land, and if so what did it actually pay?" Returns a
// structured verdict. This is the fast path for MPP: the client already
// has a confirmed tx on-chain and is handing us the hash; we verify via
// a single RPC roundtrip instead of waiting for our event watcher to
// pick it up out of the event stream.
//
// Shares parsePaymentEvent with the async watcher so the two paths
// can never disagree on what counts as a valid payment event.
//
// Pure with respect to DB and logging — no writes, no bizEvent calls.
// Callers decide what to log / persist based on the verdict.

const { Address } = require('@stellar/stellar-sdk');
const { parsePaymentEvent } = require('./parse-payment-event');

/**
 * @typedef {object} VerifyOpts
 * @property {string} txHash - Stellar tx hash the client claims paid.
 * @property {string} expectedContractId - Our receiver contract id.
 * @property {string} expectedOrderId - The challenge / order id we expect embedded in the payment.
 * @property {'usdc'|'xlm'} expectedAsset - Which asset should have been paid.
 * @property {string} expectedAmount - Decimal string, e.g. '10.00'.
 * @property {any} rpcServer - Instance of @stellar/stellar-sdk rpc.Server (injectable for tests).
 */

/**
 * @typedef {{status:'verified', payload:any, tx:{ledger:number, createdAt:number}}
 *   | {status:'pending'}
 *   | {status:'failed', reason:string}
 *   | {status:'mismatch', reason:string, payload?:any}
 *   | {status:'not_our_contract'}
 *   | {status:'rpc_error', error:string}} VerifyResult
 */

/**
 * @param {VerifyOpts} opts
 * @returns {Promise<VerifyResult>}
 */
async function verifyStellarPayment(opts) {
  const { txHash, expectedContractId, expectedOrderId, expectedAsset, expectedAmount, rpcServer } =
    opts;

  let tx;
  try {
    tx = await rpcServer.getTransaction(txHash);
  } catch (err) {
    return { status: 'rpc_error', error: /** @type {Error} */ (err).message };
  }

  if (!tx || tx.status === 'NOT_FOUND') return { status: 'pending' };
  if (tx.status === 'FAILED') {
    return { status: 'failed', reason: 'tx_applied_but_failed_on_chain' };
  }
  if (tx.status !== 'SUCCESS') {
    return { status: 'rpc_error', error: `unexpected status: ${tx.status}` };
  }

  // Extract contract events. getTransaction returns events.contractEventsXdr
  // as xdr.ContractEvent[][] (one inner array per operation). We look for
  // an event emitted by our receiver contract whose topic[0] is pay_usdc
  // or pay_xlm, and whose embedded order_id matches what we expect.
  const opEvents = tx.events?.contractEventsXdr ?? [];
  const allEvents = opEvents.flat();

  let matched = null;
  for (let i = 0; i < allEvents.length; i++) {
    const evt = allEvents[i];
    let eventContractId;
    try {
      eventContractId = Address.contract(evt.contractId()).toString();
    } catch {
      continue;
    }
    if (eventContractId !== expectedContractId) continue;

    const body = evt.body().v0();
    const syntheticEvent = {
      txHash,
      ledger: tx.ledger,
      topic: body.topics(),
      value: body.data(),
      id: `${txHash}:evt${i}`,
    };
    const parseResult = parsePaymentEvent(syntheticEvent);
    if (parseResult.ok) {
      matched = parseResult.payload;
      break;
    }
  }

  if (!matched) return { status: 'not_our_contract' };

  // Validate the match against expected constraints.
  if (matched.orderId !== expectedOrderId) {
    return { status: 'mismatch', reason: `order_id_mismatch`, payload: matched };
  }

  const expectedPaymentAsset = expectedAsset === 'usdc' ? 'usdc_soroban' : 'xlm_soroban';
  if (matched.paymentAsset !== expectedPaymentAsset) {
    return { status: 'mismatch', reason: `asset_mismatch`, payload: matched };
  }

  const actualAmount = expectedAsset === 'usdc' ? matched.amountUsdc : matched.amountXlm;
  // Compare as strings after normalising to the same precision. On-chain
  // amounts are always 7 decimals; expectedAmount may be '10' or '10.00'.
  if (normalizeDecimal(actualAmount) !== normalizeDecimal(expectedAmount)) {
    return {
      status: 'mismatch',
      reason: `amount_mismatch: expected=${expectedAmount} actual=${actualAmount}`,
      payload: matched,
    };
  }

  return {
    status: 'verified',
    payload: matched,
    tx: { ledger: tx.ledger, createdAt: tx.createdAt },
  };
}

// Normalise '10', '10.00', '10.0000000' all to the same canonical form
// for equality comparison. Strips trailing zeros but keeps at least one
// decimal place so '10' and '10.0' compare equal.
function normalizeDecimal(s) {
  if (typeof s !== 'string') return '';
  // Must be a valid decimal.
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
}

module.exports = { verifyStellarPayment, normalizeDecimal };
