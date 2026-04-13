require('../helpers/env');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { recoverStuckOrders, expireStaleOrders, pruneIdempotencyKeys } = require('../../src/jobs');
const vccClient = require('../../src/vcc-client');
const { createTestKey, resetDb, db } = require('../helpers/app');

// ── recoverStuckOrders ────────────────────────────────────────────────────────

describe('recoverStuckOrders', () => {
  beforeEach(() => {
    resetDb();
    // Default: VCC reports job as still in-progress
    vccClient.getVccJobStatus = async () => ({ status: 'queued' });
  });

  it('polls VCC, fails the order AND queues a refund (audit F10)', async () => {
    const { id: keyId } = await createTestKey({ label: 'recover-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, sender_address, api_key_id, vcc_job_id, updated_at, created_at)
      VALUES (?, 'ordering', '10.00', 'usdc', 'GTESTSENDER', ?, 'vcc-job-abc', datetime('now', '-15 minutes'), datetime('now', '-15 minutes'))
    `,
    ).run(orderId, keyId);

    vccClient.getVccJobStatus = async () => ({ status: 'failed', error: 'ctx_unavailable' });
    await recoverStuckOrders();

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    // F10: poll-recovery failure must queue a refund the same way the
    // callback path does. scheduleRefund flips failed → refund_pending.
    assert.equal(order.status, 'refund_pending');
    // Raw 'ctx_unavailable' is sanitised to a public-facing message
    // before being stored in orders.error.
    const { publicMessage } = require('../../src/lib/sanitize-error');
    assert.equal(order.error, publicMessage('ctx_unavailable'));
  });

  it('ignores orders updated recently (<10 min)', async () => {
    const { id: keyId } = await createTestKey({ label: 'recover-recent-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, vcc_job_id, updated_at, created_at)
      VALUES (?, 'ordering', '10.00', 'usdc', ?, 'vcc-job-xyz', datetime('now'), datetime('now'))
    `,
    ).run(orderId, keyId);

    let polled = false;
    vccClient.getVccJobStatus = async () => {
      polled = true;
      return { status: 'failed' };
    };
    await recoverStuckOrders();

    assert.equal(polled, false, 'should not poll VCC for recently-updated orders');
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(orderId).status,
      'ordering',
    );
  });

  it('ignores orders without vcc_job_id (legacy or approval-pending)', async () => {
    const { id: keyId } = await createTestKey({ label: 'recover-legacy-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, updated_at, created_at)
      VALUES (?, 'ordering', '10.00', 'usdc', ?, datetime('now', '-61 minutes'), datetime('now', '-61 minutes'))
    `,
    ).run(orderId, keyId);

    let polled = false;
    vccClient.getVccJobStatus = async () => {
      polled = true;
      return { status: 'failed' };
    };
    await recoverStuckOrders();

    assert.equal(polled, false, 'should not poll VCC for orders without vcc_job_id');
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(orderId).status,
      'ordering',
    );
  });
});

// ── expireStaleOrders ─────────────────────────────────────────────────────────

describe('expireStaleOrders', () => {
  before(() => resetDb());

  it('expires pending_payment orders older than 2 hours', async () => {
    const { id: keyId } = await createTestKey({ label: 'expire-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
      VALUES (?, 'pending_payment', '15.00', 'usdc', ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))
    `,
    ).run(orderId, keyId);

    expireStaleOrders();

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'expired');
  });

  it('leaves recent pending_payment orders untouched', async () => {
    const { id: keyId } = await createTestKey({ label: 'expire-recent-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
      VALUES (?, 'pending_payment', '15.00', 'usdc', ?, datetime('now'), datetime('now'))
    `,
    ).run(orderId, keyId);

    expireStaleOrders();

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'pending_payment');
  });
});

// ── pruneIdempotencyKeys ──────────────────────────────────────────────────────

describe('pruneIdempotencyKeys', () => {
  before(() => resetDb());

  it('deletes idempotency keys older than 24 hours', async () => {
    const { id: keyId } = await createTestKey({ label: 'prune-key' });
    const iKey = 'stale-idempotency-key';

    db.prepare(
      `
      INSERT INTO idempotency_keys (key, api_key_id, request_fingerprint, response_status, response_body, created_at)
      VALUES (?, ?, '', 201, '{}', datetime('now', '-25 hours'))
    `,
    ).run(iKey, keyId);

    // Confirm it was inserted
    const before = db.prepare(`SELECT * FROM idempotency_keys WHERE key = ?`).get(iKey);
    assert.ok(before, 'row should exist before pruning');

    pruneIdempotencyKeys();

    const after = db.prepare(`SELECT * FROM idempotency_keys WHERE key = ?`).get(iKey);
    assert.equal(after, undefined, 'row should be gone after pruning');
  });

  it('keeps idempotency keys created within the last 24 hours', async () => {
    const { id: keyId } = await createTestKey({ label: 'prune-fresh-key' });
    const iKey = 'fresh-idempotency-key';

    db.prepare(
      `
      INSERT INTO idempotency_keys (key, api_key_id, request_fingerprint, response_status, response_body, created_at)
      VALUES (?, ?, '', 201, '{}', datetime('now'))
    `,
    ).run(iKey, keyId);

    pruneIdempotencyKeys();

    const after = db.prepare(`SELECT * FROM idempotency_keys WHERE key = ?`).get(iKey);
    assert.ok(after, 'fresh row should still exist after pruning');
  });
});
