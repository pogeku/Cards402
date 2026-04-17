// Integration tests for the full MPP 402 → pay → retry → 200 flow.
//
// Uses a stubbed Soroban rpc.Server + stubbed handlePayment so the
// test doesn't touch real Stellar RPC or VCC. Covers:
//   - Happy path: 402 → stubbed tx confirmation → 200 with card
//   - 202 async path when delivery exceeds MPP_SYNC_WAIT_MS
//   - Replay / already-redeemed rejection
//   - Expired challenge
//   - Amount mismatch
//   - Bad credential shapes

// IMPORTANT: set the sync wait low BEFORE the app module loads, so the
// 202 test path doesn't take 10 seconds.
require('../helpers/env');
process.env.MPP_SYNC_WAIT_MS = '1500';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { xdr, Address, nativeToScVal, Keypair, StrKey } = require('@stellar/stellar-sdk');

// The default test env contract id is shape-valid but checksum-invalid
// (intentional — see test/helpers/env.js). The verifier decodes it
// via StrKey.decodeContract, which rejects bad checksums, so we need a
// real valid contract id for this test. Override the env var here, before
// the app loads via the request helper below.
process.env.RECEIVER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

const { request, db } = require('../helpers/app');
const verifyModule = require('../../src/mpp/verify');

// ── Stellar SDK stub scaffolding ─────────────────────────────────────
// Build xdr.ContractEvent-shaped objects that the verifier can decode
// via parsePaymentEvent. The only requirement from
// verifyStellarPayment's contract is: evt.contractId() returns Buffer,
// evt.body().v0() exposes topics()/data().

function makeContractEvent({
  contractId,
  symbol = 'pay_usdc',
  orderId,
  from = Keypair.random().publicKey(),
  amount = 1_000_000n,
}) {
  const topics = [
    xdr.ScVal.scvSymbol(symbol),
    nativeToScVal(Buffer.from(orderId, 'utf-8'), { type: 'bytes' }),
    new Address(from).toScVal(),
  ];
  const data = nativeToScVal(amount, { type: 'i128' });
  const contractIdBuf = StrKey.decodeContract(contractId);
  return {
    contractId: () => contractIdBuf,
    body: () => ({
      v0: () => ({ topics: () => topics, data: () => data }),
    }),
  };
}

function makeRpcStub(txResponses) {
  // txResponses: { [txHash]: { status, events? ... } }
  return {
    getTransaction: async (txHash) => txResponses[txHash] ?? { status: 'NOT_FOUND' },
  };
}

function decimalToStroops(decimal) {
  const [whole, frac = ''] = decimal.split('.');
  const padded = frac.padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(padded || '0');
}

// Fake tx response that the verifier will treat as SUCCESS with a matching
// pay_usdc event for the given challenge + amount.
function mockUsdcTx({ challengeId, amount, receiverContract }) {
  return {
    status: 'SUCCESS',
    ledger: 1_234_567,
    createdAt: 1_700_000_000,
    events: {
      contractEventsXdr: [
        [
          makeContractEvent({
            contractId: receiverContract,
            symbol: 'pay_usdc',
            orderId: challengeId,
            amount: decimalToStroops(amount),
          }),
        ],
      ],
    },
  };
}

// ── Stubbed handlePayment that mirrors the real pipeline's ────────
// post-state but without calling VCC. We write a faked 'delivered'
// row (card fields populated) so the bounded-wait sees the terminal
// state and returns 200 with the card.
const STUB_CARD = {
  number: '4111111111110000',
  cvv: '001',
  expiry: '12/27',
  brand: 'USD Visa Card',
};

async function stubHandlePayment({ orderId, txid }) {
  // Imitates a fast happy-path: mark delivered with a card.
  db.prepare(
    `UPDATE orders
        SET status = 'delivered',
            stellar_txid = @txid,
            card_number = @num,
            card_cvv = @cvv,
            card_expiry = @exp,
            card_brand = @brand
      WHERE id = @id`,
  ).run({
    id: orderId,
    txid,
    num: STUB_CARD.number,
    cvv: STUB_CARD.cvv,
    exp: STUB_CARD.expiry,
    brand: STUB_CARD.brand,
  });
}

// handlePayment stub that does nothing — for the 202 async path test
// where the order stays in pending_payment / ordering.
async function stubHandlePaymentSlow({ orderId, txid }) {
  db.prepare(`UPDATE orders SET stellar_txid = ? WHERE id = ?`).run(txid, orderId);
}

beforeEach(() => {
  db.prepare(`DELETE FROM mpp_challenges`).run();
  db.prepare(`DELETE FROM orders WHERE source = 'mpp'`).run();
  // reset stubs
  verifyModule._setRpcServer(null);
  verifyModule._setHandlePayment(null);
});

// Helper: fetch a fresh 402 and return the challenge body.
async function getChallenge(amount) {
  const res = await request.get(`/v1/cards/visa/${amount}`);
  assert.equal(res.status, 402);
  return res.body;
}

describe('MPP happy path — 402 then 200 with card', () => {
  it('verifies payment, creates order, returns card synchronously', async () => {
    const challenge = await getChallenge('10.00');

    // Stub the Soroban RPC to return a matching tx for this challenge.
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txHash = 'aa'.repeat(32);
    verifyModule._setRpcServer(
      makeRpcStub({
        [txHash]: mockUsdcTx({
          challengeId: challenge.challenge_id,
          amount: '10.00',
          receiverContract,
        }),
      }),
    );
    verifyModule._setHandlePayment(stubHandlePayment);

    const res = await request
      .get('/v1/cards/visa/10.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`,
      );

    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'delivered');
    assert.equal(res.body.challenge_id, challenge.challenge_id);
    assert.equal(res.body.tx_hash, txHash);
    assert.equal(res.body.card.number, STUB_CARD.number);
    assert.equal(res.body.card.cvv, STUB_CARD.cvv);
    assert.match(res.headers['payment-receipt'], /challenge=/);
    assert.match(res.headers['payment-receipt'], new RegExp(`tx_hash="${txHash}"`));

    // The challenge row is now redeemed, bound to the tx.
    const row = db.prepare(`SELECT * FROM mpp_challenges WHERE id = ?`).get(challenge.challenge_id);
    assert.ok(row.redeemed_at);
    assert.equal(row.redeemed_tx_hash, txHash);
    assert.equal(row.order_id, res.body.order_id);
  });
});

describe('MPP slow-fulfillment path — 202 + Location', () => {
  it('hands off to receipts when delivery exceeds sync wait', async () => {
    const challenge = await getChallenge('3.00');
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txHash = 'bb'.repeat(32);

    verifyModule._setRpcServer(
      makeRpcStub({
        [txHash]: mockUsdcTx({
          challengeId: challenge.challenge_id,
          amount: '3.00',
          receiverContract,
        }),
      }),
    );
    verifyModule._setHandlePayment(stubHandlePaymentSlow);

    const res = await request
      .get('/v1/cards/visa/3.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`,
      );

    assert.equal(res.status, 202);
    assert.equal(res.body.state, 'fulfilling');
    assert.ok(res.body.receipt_id.startsWith('mpp_r_'));
    assert.match(res.headers.location, /\/v1\/mpp\/receipts\/mpp_r_/);

    // Now simulate CTX callback marking delivered. Polling the receipt
    // should then return 200 with the card.
    db.prepare(
      `UPDATE orders
          SET status = 'delivered',
              card_number = ?, card_cvv = ?, card_expiry = ?, card_brand = ?
        WHERE id = ?`,
    ).run(STUB_CARD.number, STUB_CARD.cvv, STUB_CARD.expiry, STUB_CARD.brand, res.body.order_id);

    const receiptRes = await request.get(res.headers.location);
    assert.equal(receiptRes.status, 200);
    assert.equal(receiptRes.body.state, 'delivered');
    assert.equal(receiptRes.body.card.number, STUB_CARD.number);
  });
});

describe('MPP replay protection', () => {
  it('rejects reusing the same tx on a new challenge (409 payment_already_redeemed)', async () => {
    // Redeem challenge A with txHash.
    const a = await getChallenge('1.00');
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txHash = 'cc'.repeat(32);

    verifyModule._setRpcServer(
      makeRpcStub({
        [txHash]: mockUsdcTx({
          challengeId: a.challenge_id,
          amount: '1.00',
          receiverContract,
        }),
      }),
    );
    verifyModule._setHandlePayment(stubHandlePayment);

    const first = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${a.challenge_id}", tx_hash="${txHash}"`,
      );
    assert.equal(first.status, 200);

    // Now get challenge B and try to redeem with the same tx.
    const b = await getChallenge('1.00');
    // Update the stubbed rpc to return a tx matching B's challenge id
    // (otherwise the verifier would reject on order_id_mismatch first,
    // before the UNIQUE index fires). To force the replay code path,
    // we have to lie about the tx — simulate an attacker who crafts
    // a valid-looking tx that already matches an earlier challenge.
    // Simplest: reuse the SAME tx content (which still references A's
    // challenge id) and attempt to redeem against B. The on-chain
    // event's order_id won't match B, so we get mismatch → 402.
    // To actually exercise the UNIQUE tx_hash guard we stub an rpc
    // response that matches B's challenge id with the same tx_hash.
    verifyModule._setRpcServer(
      makeRpcStub({
        [txHash]: mockUsdcTx({
          challengeId: b.challenge_id,
          amount: '1.00',
          receiverContract,
        }),
      }),
    );

    const second = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${b.challenge_id}", tx_hash="${txHash}"`,
      );
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'payment_already_redeemed');
  });

  it('idempotent retry: same credential repeated returns same order', async () => {
    const challenge = await getChallenge('1.00');
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txHash = 'dd'.repeat(32);

    verifyModule._setRpcServer(
      makeRpcStub({
        [txHash]: mockUsdcTx({
          challengeId: challenge.challenge_id,
          amount: '1.00',
          receiverContract,
        }),
      }),
    );
    verifyModule._setHandlePayment(stubHandlePayment);

    const first = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`,
      );
    assert.equal(first.status, 200);

    const retry = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`,
      );
    // Idempotent retry produces the same underlying order (via the
    // challenge.redeemed_at branch in verify.js) — currently reaches
    // the delivery wait which sees the order already delivered.
    assert.equal(retry.status, 200);
    assert.equal(retry.body.order_id, first.body.order_id);
  });
});

describe('MPP rejections', () => {
  it('401 on unknown challenge', async () => {
    const res = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="mpp_c_unknown", tx_hash="${'ee'.repeat(32)}"`,
      );
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'challenge_not_found');
  });

  it('401 on expired challenge', async () => {
    const challenge = await getChallenge('1.00');
    db.prepare(
      `UPDATE mpp_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    ).run(challenge.challenge_id);
    const res = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${'ff'.repeat(32)}"`,
      );
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'challenge_expired');
  });

  it('400 on resource mismatch (challenge for /1.00 used at /5.00)', async () => {
    const challenge = await getChallenge('1.00');
    const res = await request
      .get('/v1/cards/visa/5.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${'11'.repeat(32)}"`,
      );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'resource_mismatch');
  });

  it('425 pending when Soroban RPC returns NOT_FOUND', async () => {
    const challenge = await getChallenge('1.00');
    const txHash = '22'.repeat(32);
    verifyModule._setRpcServer(makeRpcStub({})); // no matching tx → NOT_FOUND
    const res = await request
      .get('/v1/cards/visa/1.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`,
      );
    assert.equal(res.status, 425);
    assert.equal(res.body.error, 'payment_pending');
  });

  it('402 on amount mismatch', async () => {
    const challenge = await getChallenge('5.00');
    const receiverContract = process.env.RECEIVER_CONTRACT_ID;
    const txHash = '33'.repeat(32);
    // Returns a tx that paid $1.00 against a $5.00 challenge.
    verifyModule._setRpcServer(
      makeRpcStub({
        [txHash]: mockUsdcTx({
          challengeId: challenge.challenge_id,
          amount: '1.00',
          receiverContract,
        }),
      }),
    );
    const res = await request
      .get('/v1/cards/visa/5.00')
      .set(
        'Authorization',
        `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`,
      );
    assert.equal(res.status, 402);
    assert.equal(res.body.error, 'payment_verification_failed');
    // Challenge was NOT marked redeemed — pending verdict let the user
    // retry with a different (correct) tx.
    const row = db.prepare(`SELECT * FROM mpp_challenges WHERE id = ?`).get(challenge.challenge_id);
    assert.equal(row.redeemed_at, null);
  });
});
