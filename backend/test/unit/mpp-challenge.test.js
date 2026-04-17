// Unit tests for backend/src/mpp/challenge.js
//
// Covers challenge lifecycle (create/load/redeem/sweep) including the
// concurrency + replay guards that keep MPP honest:
//   - Atomic CAS on redemption (can't double-redeem)
//   - UNIQUE tx_hash index (can't reuse one tx on two challenges)
//   - Expiry check before redemption
//   - Idempotent retry with the same tx

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/db');
const {
  createChallenge,
  loadChallenge,
  redeemChallenge,
  generateReceiptId,
  attachReceiptId,
  loadOrderByReceiptId,
  sweepExpiredChallenges,
  CHALLENGE_ID_PREFIX,
  RECEIPT_ID_PREFIX,
} = require('../../src/mpp/challenge');

// Insert a fake order that the challenge-to-order attachment tests
// can reference. Minimal column set — the schema has most columns
// nullable for mid-flow states.
function insertFakeOrder(id) {
  db.prepare(
    `INSERT INTO orders (id, status, amount_usdc, api_key_id, source)
     VALUES (?, 'pending_payment', '1.00', 'mpp-anonymous', 'mpp')`,
  ).run(id);
}

beforeEach(() => {
  db.prepare(`DELETE FROM mpp_challenges`).run();
  db.prepare(`DELETE FROM orders WHERE source = 'mpp'`).run();
});

describe('createChallenge + loadChallenge', () => {
  it('inserts a row and returns its shape', () => {
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/10.00',
      amountUsdc: '10.00',
      clientIp: '1.2.3.4',
      ttlMs: 600_000,
    });
    assert.ok(c.id.startsWith(CHALLENGE_ID_PREFIX));
    assert.equal(c.amountUsdc, '10.00');
    assert.equal(c.resourcePath, '/v1/cards/visa/10.00');
    assert.ok(c.expiresAt.getTime() > c.createdAt.getTime());

    const loaded = loadChallenge(c.id);
    assert.ok(loaded);
    assert.equal(loaded.amount_usdc, '10.00');
    assert.equal(loaded.client_ip, '1.2.3.4');
  });

  it('generates unique ids across calls', () => {
    const a = createChallenge({
      resourcePath: '/v1/cards/visa/1.00',
      amountUsdc: '1.00',
      clientIp: null,
      ttlMs: 1000,
    });
    const b = createChallenge({
      resourcePath: '/v1/cards/visa/1.00',
      amountUsdc: '1.00',
      clientIp: null,
      ttlMs: 1000,
    });
    assert.notEqual(a.id, b.id);
  });

  it('loadChallenge returns null for non-existent or malformed ids', () => {
    assert.equal(loadChallenge('mpp_c_does_not_exist'), null);
    assert.equal(loadChallenge('not-a-challenge-id'), null);
    assert.equal(loadChallenge(''), null);
    // @ts-ignore
    assert.equal(loadChallenge(null), null);
  });
});

describe('redeemChallenge', () => {
  it('marks a live challenge redeemed against a tx', () => {
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    insertFakeOrder('order-1');
    const result = redeemChallenge({ id: c.id, txHash: 'tx'.repeat(32), orderId: 'order-1' });
    assert.deepEqual(result, { ok: true });

    const row = loadChallenge(c.id);
    assert.ok(row.redeemed_at);
    assert.equal(row.redeemed_tx_hash, 'tx'.repeat(32));
    assert.equal(row.order_id, 'order-1');
  });

  it('rejects a second redemption with a different tx (already_redeemed)', () => {
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    insertFakeOrder('order-1');
    insertFakeOrder('order-2');
    const first = redeemChallenge({ id: c.id, txHash: 'aa'.repeat(32), orderId: 'order-1' });
    assert.equal(first.ok, true);
    const second = redeemChallenge({ id: c.id, txHash: 'bb'.repeat(32), orderId: 'order-2' });
    assert.deepEqual(second, { ok: false, reason: 'already_redeemed' });
  });

  it('is idempotent on a retry with the same tx', () => {
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    insertFakeOrder('order-1');
    const first = redeemChallenge({ id: c.id, txHash: 'aa'.repeat(32), orderId: 'order-1' });
    assert.equal(first.ok, true);
    const retry = redeemChallenge({ id: c.id, txHash: 'aa'.repeat(32), orderId: 'order-1' });
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
  });

  it('rejects redemption of an expired challenge', () => {
    // Create an already-expired row by setting ttl in the past. Since
    // createChallenge takes ttlMs, we can't directly set expires_at
    // in the past via the API — poke the DB instead for this one edge.
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    db.prepare(
      `UPDATE mpp_challenges SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
    ).run(c.id);
    insertFakeOrder('order-1');
    const result = redeemChallenge({ id: c.id, txHash: 'aa'.repeat(32), orderId: 'order-1' });
    assert.deepEqual(result, { ok: false, reason: 'expired' });
  });

  it('rejects redemption of a non-existent challenge', () => {
    insertFakeOrder('order-1');
    const result = redeemChallenge({
      id: 'mpp_c_does_not_exist',
      txHash: 'aa'.repeat(32),
      orderId: 'order-1',
    });
    assert.deepEqual(result, { ok: false, reason: 'not_found' });
  });

  it('rejects reuse of a tx hash on a different challenge (tx_already_used)', () => {
    const a = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    const b = createChallenge({
      resourcePath: '/v1/cards/visa/3.00',
      amountUsdc: '3.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    insertFakeOrder('order-a');
    insertFakeOrder('order-b');
    const first = redeemChallenge({ id: a.id, txHash: 'cc'.repeat(32), orderId: 'order-a' });
    assert.equal(first.ok, true);
    const second = redeemChallenge({ id: b.id, txHash: 'cc'.repeat(32), orderId: 'order-b' });
    assert.deepEqual(second, { ok: false, reason: 'tx_already_used' });
  });
});

describe('attachReceiptId + loadOrderByReceiptId', () => {
  it('attaches a receipt id via the challenge and resolves back to the order', () => {
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    insertFakeOrder('order-1');
    // Tie the order to the challenge manually (in production this is
    // done by the MPP handler before attachReceiptId).
    db.prepare(`UPDATE orders SET mpp_challenge_id = ? WHERE id = ?`).run(c.id, 'order-1');

    const receiptId = generateReceiptId();
    assert.ok(receiptId.startsWith(RECEIPT_ID_PREFIX));
    attachReceiptId({ challengeId: c.id, receiptId });

    const loaded = loadOrderByReceiptId(receiptId);
    assert.ok(loaded);
    assert.equal(loaded.id, 'order-1');
  });

  it('loadOrderByReceiptId rejects malformed ids', () => {
    assert.equal(loadOrderByReceiptId('not-a-receipt'), null);
    assert.equal(loadOrderByReceiptId(''), null);
    // @ts-ignore
    assert.equal(loadOrderByReceiptId(null), null);
  });
});

describe('sweepExpiredChallenges', () => {
  it('deletes expired, never-redeemed rows older than 24h', () => {
    const old = createChallenge({
      resourcePath: '/v1/cards/visa/1.00',
      amountUsdc: '1.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    // Force it into the sweep window.
    db.prepare(
      `UPDATE mpp_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    ).run(old.id);

    const live = createChallenge({
      resourcePath: '/v1/cards/visa/2.00',
      amountUsdc: '2.00',
      clientIp: null,
      ttlMs: 600_000,
    });

    const { deleted } = sweepExpiredChallenges();
    assert.equal(deleted, 1);
    assert.equal(loadChallenge(old.id), null);
    assert.ok(loadChallenge(live.id));
  });

  it('preserves redeemed rows even if they are old', () => {
    const c = createChallenge({
      resourcePath: '/v1/cards/visa/1.00',
      amountUsdc: '1.00',
      clientIp: null,
      ttlMs: 600_000,
    });
    insertFakeOrder('order-1');
    redeemChallenge({ id: c.id, txHash: 'dd'.repeat(32), orderId: 'order-1' });
    db.prepare(
      `UPDATE mpp_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    ).run(c.id);

    const { deleted } = sweepExpiredChallenges();
    assert.equal(deleted, 0);
    const row = loadChallenge(c.id);
    assert.ok(row);
    assert.equal(row.redeemed_tx_hash, 'dd'.repeat(32));
  });
});
