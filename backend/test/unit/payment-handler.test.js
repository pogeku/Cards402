// Unit tests for backend/src/payment-handler.js.
//
// Before the 2026-04-15 adversarial audit there were NO direct unit
// tests for this module — it was only exercised indirectly through
// the e2e-cards402-vcc integration test. This file covers the three
// audit findings and the two helpers added alongside them:
//
//   F1-payment-handler: the outer catch handler now uses
//     safeErrorMessage() so a non-Error thrown value (null, string,
//     Error with getter-thrown .message) can't crash the catch block
//     and leave the order wedged in 'ordering' status.
//
//   F2-payment-handler: parseStrictPositiveStroops() validates
//     order.amount_usdc before the comparison. Pre-fix, an empty or
//     corrupt amount_usdc row would be treated as "paid the full
//     quoted amount" because toStroops('') returned 0n and any
//     positive on-chain payment compared as overpayment — a corrupt
//     row became a treasury drain vector. Post-fix, corrupt rows
//     route the incoming event to unmatched_payments and leave the
//     order in pending_payment for ops.
//
//   F3-payment-handler: USDC overpayment now emits a
//     payment.usdc_overpaid bizEvent so a buggy SDK systematically
//     over-paying doesn't silently accumulate excess.
//
// The happy-path + race tests are covered by the existing integration
// suite; this file focuses on the helpers (pure functions) and the
// F2 corrupt-amount path end-to-end via a DB-backed test.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb, createTestKey } = require('../helpers/app');

const {
  handlePayment,
  _parseStrictPositiveStroops,
  _safeErrorMessage,
} = require('../../src/payment-handler');

// ── F1-payment-handler: safeErrorMessage ────────────────────────────────────

describe('F1-payment-handler: safeErrorMessage', () => {
  it('extracts .message from a plain Error', () => {
    assert.equal(_safeErrorMessage(new Error('boom')), 'boom');
  });

  it('returns a string unchanged', () => {
    assert.equal(_safeErrorMessage('a plain string error'), 'a plain string error');
  });

  it('returns the literal "null" for null', () => {
    assert.equal(_safeErrorMessage(null), 'null');
  });

  it('returns the literal "undefined" for undefined', () => {
    assert.equal(_safeErrorMessage(undefined), 'undefined');
  });

  it('returns String-coerced form for a number', () => {
    assert.equal(_safeErrorMessage(42), '42');
  });

  it('handles an Error whose .message getter throws', () => {
    const err = new Error();
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('nested');
      },
    });
    const out = _safeErrorMessage(err);
    // Must not throw. String(err) is the fallback path.
    assert.ok(typeof out === 'string');
  });

  it('returns <unstringifiable error> for a value whose toString throws', () => {
    const weird = /** @type {any} */ ({
      toString() {
        throw new Error('nope');
      },
    });
    assert.equal(_safeErrorMessage(weird), '<unstringifiable error>');
  });
});

// ── F2-payment-handler: parseStrictPositiveStroops helper ──────────────────

describe('F2-payment-handler: parseStrictPositiveStroops', () => {
  it('accepts a simple positive integer', () => {
    assert.equal(_parseStrictPositiveStroops('1'), 10_000_000n);
  });

  it('accepts a positive decimal', () => {
    assert.equal(_parseStrictPositiveStroops('0.0123456'), 123_456n);
  });

  it('accepts "10.00"', () => {
    assert.equal(_parseStrictPositiveStroops('10.00'), 100_000_000n);
  });

  it('rejects empty string', () => {
    assert.equal(_parseStrictPositiveStroops(''), null);
  });

  it('rejects whitespace-only string', () => {
    assert.equal(_parseStrictPositiveStroops('   '), null);
  });

  it('rejects null and undefined', () => {
    assert.equal(_parseStrictPositiveStroops(null), null);
    assert.equal(_parseStrictPositiveStroops(undefined), null);
  });

  it('rejects non-string types', () => {
    // @ts-expect-error intentional
    assert.equal(_parseStrictPositiveStroops(10), null);
    // @ts-expect-error intentional
    assert.equal(_parseStrictPositiveStroops(true), null);
    // @ts-expect-error intentional
    assert.equal(_parseStrictPositiveStroops({ amount: '10' }), null);
  });

  it('rejects zero', () => {
    // The whole point of the guard — zero is the exact value that
    // pre-fix caused the treasury drain.
    assert.equal(_parseStrictPositiveStroops('0'), null);
    assert.equal(_parseStrictPositiveStroops('0.0000000'), null);
  });

  it('rejects negative', () => {
    assert.equal(_parseStrictPositiveStroops('-1'), null);
    assert.equal(_parseStrictPositiveStroops('-0.5'), null);
  });

  it('rejects garbage strings', () => {
    assert.equal(_parseStrictPositiveStroops('abc'), null);
    assert.equal(_parseStrictPositiveStroops('1.2.3'), null);
    assert.equal(_parseStrictPositiveStroops('1e5'), null);
    assert.equal(_parseStrictPositiveStroops('NaN'), null);
    assert.equal(_parseStrictPositiveStroops('Infinity'), null);
    assert.equal(_parseStrictPositiveStroops('+1'), null);
  });
});

// ── F2-payment-handler: end-to-end corrupt-order protection ─────────────────
//
// Prove that a DB-backed order row with a corrupt amount_usdc value is
// NOT claimed when an on-chain payment arrives. The incoming event is
// routed to unmatched_payments with reason='corrupt_order' and the
// order stays in pending_payment status for ops to investigate.

describe('F2-payment-handler: corrupt order.amount_usdc is fail-closed', () => {
  let apiKeyId;

  beforeEach(async () => {
    resetDb();
    const key = await createTestKey({ label: 'corrupt-test' });
    apiKeyId = key.id;
  });

  function seedOrder({ id = uuidv4(), amountUsdc = '10.00', status = 'pending_payment' } = {}) {
    db.prepare(
      `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
       VALUES (?, ?, ?, 'usdc', ?, datetime('now'), datetime('now'))`,
    ).run(id, status, amountUsdc, apiKeyId);
    return id;
  }

  async function payUsdc(orderId, amountUsdc, txid = `TX${uuidv4().slice(0, 8)}`) {
    await handlePayment({
      txid,
      paymentAsset: 'usdc_soroban',
      amountUsdc,
      amountXlm: null,
      senderAddress: 'GTESTSENDER',
      orderId,
    });
    return txid;
  }

  function getOrder(id) {
    return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
  }

  function findUnmatched(txid) {
    return db.prepare(`SELECT * FROM unmatched_payments WHERE stellar_txid = ?`).get(txid);
  }

  it('routes to corrupt_order when amount_usdc is empty string', async () => {
    const orderId = seedOrder({ amountUsdc: '' });
    const txid = await payUsdc(orderId, '10.00');
    // Order must still be pending_payment — NOT claimed.
    const order = getOrder(orderId);
    assert.equal(order.status, 'pending_payment');
    // Unmatched row recorded with the specific reason.
    const unmatched = findUnmatched(txid);
    assert.ok(unmatched, 'expected unmatched_payments row for corrupt order');
    assert.equal(unmatched.reason, 'corrupt_order');
    assert.equal(unmatched.claimed_order_id, orderId);
  });

  it('routes to corrupt_order when amount_usdc is "0"', async () => {
    // The specific value that caused the pre-fix treasury-drain
    // comparison. toStroops('0') === 0n, and any positive on-chain
    // amount compared as "overpayment" and transitioned the order to
    // 'ordering'. Post-fix: rejected at parseStrictPositiveStroops.
    const orderId = seedOrder({ amountUsdc: '0' });
    const txid = await payUsdc(orderId, '10.00');
    const order = getOrder(orderId);
    assert.equal(order.status, 'pending_payment');
    assert.equal(findUnmatched(txid).reason, 'corrupt_order');
  });

  it('routes to corrupt_order when amount_usdc is "not-a-number"', async () => {
    const orderId = seedOrder({ amountUsdc: 'abc' });
    const txid = await payUsdc(orderId, '10.00');
    assert.equal(getOrder(orderId).status, 'pending_payment');
    assert.equal(findUnmatched(txid).reason, 'corrupt_order');
  });

  it('routes to corrupt_order when amount_usdc has multiple dots', async () => {
    const orderId = seedOrder({ amountUsdc: '10.0.0' });
    const txid = await payUsdc(orderId, '10.00');
    assert.equal(getOrder(orderId).status, 'pending_payment');
    assert.equal(findUnmatched(txid).reason, 'corrupt_order');
  });

  it('routes to corrupt_order when amount_usdc is negative', async () => {
    const orderId = seedOrder({ amountUsdc: '-10.00' });
    const txid = await payUsdc(orderId, '10.00');
    assert.equal(getOrder(orderId).status, 'pending_payment');
    assert.equal(findUnmatched(txid).reason, 'corrupt_order');
  });

  it('still CLAIMS a valid decimal amount (regression guard for the F2 guard itself)', async () => {
    // The F2 guard must not reject valid amounts. We can't cleanly stub
    // vcc-client here (payment-handler.js destructures getInvoice at
    // module load, so runtime reassignment doesn't affect the cached
    // binding), so instead we assert the MINIMUM thing the F2 guard is
    // responsible for: a valid amount_usdc causes the order to exit
    // pending_payment status. Whatever happens downstream (getInvoice
    // failing against the test stub, falling into the catch handler,
    // scheduling a refund) is out of scope for this test and is covered
    // by the e2e integration suite.
    //
    // Silence the expected downstream error logs so the test output is
    // readable.
    const origError = console.error;
    console.error = () => {};
    try {
      const orderId = seedOrder({ amountUsdc: '10.00' });
      await payUsdc(orderId, '10.00');
      const order = getOrder(orderId);
      assert.notEqual(
        order.status,
        'pending_payment',
        'valid amount_usdc should claim the order (F2 guard must not false-positive)',
      );
      // No unmatched_payments row with corrupt_order reason.
      const corruptRow = db
        .prepare(`SELECT * FROM unmatched_payments WHERE claimed_order_id = ? AND reason = ?`)
        .get(orderId, 'corrupt_order');
      assert.equal(corruptRow, undefined, 'valid amount must not land in unmatched_payments');
    } finally {
      console.error = origError;
    }
  });
});

// ── F3-payment-handler: USDC overpayment bizEvent ──────────────────────────
//
// Pre-fix, USDC overpayment was silently accepted — excess_usdc was
// recorded on the order row but no bizEvent fired, so a buggy SDK
// systematically over-paying by 10% would go unnoticed. XLM had the
// symmetric payment.xlm_overpaid signal already; USDC now matches.

describe('F3-payment-handler: usdc_overpaid bizEvent', () => {
  let apiKeyId;

  beforeEach(async () => {
    resetDb();
    const key = await createTestKey({ label: 'overpaid-test' });
    apiKeyId = key.id;
  });

  it('emits payment.usdc_overpaid when the agent pays more than expected', async () => {
    // Capture bizEvent emissions.
    const logger = require('../../src/lib/logger');
    const origEvent = logger.event;
    const events = [];
    logger.event = (name, fields) => events.push({ name, fields });

    // Silence the expected downstream error logs after the (successful)
    // claim — same reason as the prior regression guard.
    const origError = console.error;
    console.error = () => {};

    try {
      const orderId = uuidv4();
      db.prepare(
        `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
         VALUES (?, 'pending_payment', '10.00', 'usdc', ?, datetime('now'), datetime('now'))`,
      ).run(orderId, apiKeyId);

      await handlePayment({
        txid: 'TX_OVERPAID',
        paymentAsset: 'usdc_soroban',
        amountUsdc: '11.50', // $1.50 overpayment
        amountXlm: null,
        senderAddress: 'GOVER',
        orderId,
      });

      const overpaid = events.find((e) => e.name === 'payment.usdc_overpaid');
      assert.ok(overpaid, 'expected payment.usdc_overpaid bizEvent');
      assert.equal(overpaid.fields.order_id, orderId);
      assert.equal(overpaid.fields.expected_usdc, '10.00');
      assert.equal(overpaid.fields.paid_usdc, '11.50');
      // excess_usdc should be '1.5000000' (stroop-precision stringification).
      assert.match(overpaid.fields.excess_usdc, /^1\.5000000$/);
      assert.equal(overpaid.fields.txid, 'TX_OVERPAID');
    } finally {
      logger.event = origEvent;
      console.error = origError;
    }
  });

  it('does NOT emit payment.usdc_overpaid on an exact match', async () => {
    const logger = require('../../src/lib/logger');
    const origEvent = logger.event;
    const events = [];
    logger.event = (name, fields) => events.push({ name, fields });
    const origError = console.error;
    console.error = () => {};

    try {
      const orderId = uuidv4();
      db.prepare(
        `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
         VALUES (?, 'pending_payment', '10.00', 'usdc', ?, datetime('now'), datetime('now'))`,
      ).run(orderId, apiKeyId);

      await handlePayment({
        txid: 'TX_EXACT',
        paymentAsset: 'usdc_soroban',
        amountUsdc: '10.00',
        amountXlm: null,
        senderAddress: 'GEXACT',
        orderId,
      });

      const overpaid = events.filter((e) => e.name === 'payment.usdc_overpaid');
      assert.equal(overpaid.length, 0, 'exact match must not emit overpaid bizEvent');
    } finally {
      logger.event = origEvent;
      console.error = origError;
    }
  });
});
