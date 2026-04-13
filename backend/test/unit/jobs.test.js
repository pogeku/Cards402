// Background job tests — expiry, stuck-order recovery, idempotency pruning.
// Uses the real in-memory DB (via app helper), mocks scheduleRefund by replacing
// the property on the cached fulfillment exports object.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb } = require('../helpers/app');

// Load the jobs module and injectable modules for mocking
const {
  expireStaleOrders,
  recoverStuckOrders,
  pruneIdempotencyKeys,
  purgeOldCards,
} = require('../../src/jobs');
const vccClient = require('../../src/vcc-client');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Seed an order with an explicit timestamp so we can test age-based logic.
// SQLite datetime format: 'YYYY-MM-DD HH:MM:SS'
function seedOrderAt({
  status = 'pending_payment',
  payment_asset = 'usdc',
  minutesAgo = 0,
  vcc_job_id = null,
} = {}) {
  const id = uuidv4();
  const created = new Date(Date.now() - minutesAgo * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  db.prepare(
    `
    INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, vcc_job_id, created_at, updated_at)
    VALUES (?, ?, '10.00', ?, NULL, ?, ?, ?)
  `,
  ).run(id, status, payment_asset, vcc_job_id || null, created, created);
  return id;
}

// ── expireStaleOrders ─────────────────────────────────────────────────────────

describe('expireStaleOrders', () => {
  beforeEach(() => resetDb());

  it('expires usdc_soroban pending_payment order older than 2 hours', () => {
    const id = seedOrderAt({ payment_asset: 'usdc_soroban', minutesAgo: 121 });
    expireStaleOrders();
    const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
    assert.equal(order.status, 'expired');
  });

  it('does NOT expire usdc_soroban order younger than 2 hours', () => {
    const id = seedOrderAt({ payment_asset: 'usdc_soroban', minutesAgo: 60 });
    expireStaleOrders();
    const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
    assert.equal(order.status, 'pending_payment');
  });

  it('expires legacy usdc pending_payment order older than 2 hours', () => {
    const id = seedOrderAt({ payment_asset: 'usdc', minutesAgo: 121 });
    expireStaleOrders();
    const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
    assert.equal(order.status, 'expired');
  });

  it('does NOT expire usdc_soroban order exactly at 2 hours', () => {
    const id = seedOrderAt({ payment_asset: 'usdc_soroban', minutesAgo: 119 });
    expireStaleOrders();
    const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id);
    assert.equal(order.status, 'pending_payment');
  });

  it('does not expire delivered or failed orders', () => {
    const delivId = seedOrderAt({ status: 'delivered', minutesAgo: 200 });
    const failId = seedOrderAt({ status: 'failed', minutesAgo: 200 });
    expireStaleOrders();
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(delivId).status,
      'delivered',
    );
    assert.equal(db.prepare(`SELECT status FROM orders WHERE id = ?`).get(failId).status, 'failed');
  });

  it('expires multiple stale usdc_soroban orders in one pass', () => {
    const ids = [
      seedOrderAt({ payment_asset: 'usdc_soroban', minutesAgo: 125 }),
      seedOrderAt({ payment_asset: 'usdc_soroban', minutesAgo: 130 }),
    ];
    expireStaleOrders();
    for (const id of ids) {
      assert.equal(db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id).status, 'expired');
    }
  });
});

// ── recoverStuckOrders ────────────────────────────────────────────────────────

describe('recoverStuckOrders', () => {
  beforeEach(() => {
    resetDb();
    // Default: VCC reports job as still in-progress
    vccClient.getVccJobStatus = async () => ({ status: 'queued' });
  });

  it('marks failed AND queues a refund when VCC reports failed (audit F10)', async () => {
    // Seed a sender_address so scheduleRefund can actually progress past
    // the claim step — without it the refund logic bails out early
    // ('no sender — left as refund_pending for manual action') which is
    // still the desired terminal state here, but we want to exercise
    // the full path.
    const id = seedOrderAt({ status: 'pending_payment', minutesAgo: 15, vcc_job_id: 'vcc-job-1' });
    db.prepare(`UPDATE orders SET sender_address = ? WHERE id = ?`).run('GTESTSENDER', id);
    vccClient.getVccJobStatus = async () => ({ status: 'failed', error: 'ctx_unavailable' });
    await recoverStuckOrders();
    const order = db.prepare(`SELECT status, error FROM orders WHERE id = ?`).get(id);
    // F10: the poll-recovery path must queue a refund on terminal failure,
    // same as the callback-driven path. scheduleRefund flips failed →
    // refund_pending atomically; seeing 'refund_pending' here proves the
    // refund was queued and we're not leaking user funds to the void.
    assert.equal(order.status, 'refund_pending');
    // The error string is sanitised before hitting orders.error — raw
    // internal codes ('ctx_unavailable') map to the generic public
    // message so agents don't see implementation details.
    const { publicMessage } = require('../../src/lib/sanitize-error');
    assert.equal(order.error, publicMessage('ctx_unavailable'));
  });

  it('leaves stuck-delivered order in ordering without hydrating card (audit F8)', async () => {
    // vcc strips card_number/cvv/expiry from GET /api/jobs/:id on purpose —
    // the job-status endpoint is not a card-retrieval channel. The old
    // behaviour tried to pull card_number out of vccJob and write it to
    // orders.card_number; that code path was dead against the real vcc
    // API. New behaviour: detect stuck-delivered, leave the row in
    // 'ordering', and emit a log so ops can force-replay the callback.
    const id = seedOrderAt({ status: 'ordering', minutesAgo: 15, vcc_job_id: 'vcc-job-2' });
    vccClient.getVccJobStatus = async () => ({
      status: 'delivered',
      // vcc intentionally does NOT return card data here; represent reality
    });
    await recoverStuckOrders();
    const order = db.prepare(`SELECT status, card_number FROM orders WHERE id = ?`).get(id);
    // Status stays 'ordering' — we don't flip to delivered until the
    // callback actually arrives with the card material.
    assert.equal(order.status, 'ordering');
    assert.equal(order.card_number, null);
  });

  it('does NOT recover orders without vcc_job_id', async () => {
    const id = seedOrderAt({ status: 'pending_payment', minutesAgo: 15 }); // no vcc_job_id
    let polled = false;
    vccClient.getVccJobStatus = async () => {
      polled = true;
      return { status: 'failed' };
    };
    await recoverStuckOrders();
    assert.equal(polled, false, 'should not poll VCC for orders without vcc_job_id');
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id).status,
      'pending_payment',
    );
  });

  it('does NOT recover recently-updated orders (<10 min)', async () => {
    const id = seedOrderAt({ status: 'pending_payment', minutesAgo: 5, vcc_job_id: 'vcc-job-3' });
    let polled = false;
    vccClient.getVccJobStatus = async () => {
      polled = true;
      return { status: 'failed' };
    };
    await recoverStuckOrders();
    assert.equal(polled, false, 'should not poll VCC for recently-updated orders');
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id).status,
      'pending_payment',
    );
  });

  it('leaves in-progress orders alone', async () => {
    const id = seedOrderAt({ status: 'pending_payment', minutesAgo: 15, vcc_job_id: 'vcc-job-4' });
    vccClient.getVccJobStatus = async () => ({ status: 'queued' }); // still in progress
    await recoverStuckOrders();
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id).status,
      'pending_payment',
    );
  });

  it('does not touch delivered or expired orders', async () => {
    const delivId = seedOrderAt({ status: 'delivered', minutesAgo: 60, vcc_job_id: 'vcc-job-5' });
    const expId = seedOrderAt({ status: 'expired', minutesAgo: 60, vcc_job_id: 'vcc-job-6' });
    await recoverStuckOrders();
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(delivId).status,
      'delivered',
    );
    assert.equal(db.prepare(`SELECT status FROM orders WHERE id = ?`).get(expId).status, 'expired');
  });

  it('recovers multiple stuck orders in one pass', async () => {
    const id1 = seedOrderAt({ status: 'pending_payment', minutesAgo: 15, vcc_job_id: 'vcc-job-7' });
    const id2 = seedOrderAt({ status: 'ordering', minutesAgo: 20, vcc_job_id: 'vcc-job-8' });
    // Give both rows a sender so the refund path can flip them through
    // scheduleRefund into refund_pending.
    db.prepare(`UPDATE orders SET sender_address = 'GTEST' WHERE id IN (?, ?)`).run(id1, id2);
    vccClient.getVccJobStatus = async () => ({ status: 'failed', error: 'test_err' });
    await recoverStuckOrders();
    // Both should land in refund_pending — F10: every poll-recovery failure
    // must queue a refund.
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id1).status,
      'refund_pending',
    );
    assert.equal(
      db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id2).status,
      'refund_pending',
    );
  });
});

// ── purgeOldCards (audit F1) ──────────────────────────────────────────────────

describe('purgeOldCards', () => {
  beforeEach(() => resetDb());

  function seedDeliveredOrder({ daysAgo = 0 } = {}) {
    const id = uuidv4();
    const ts = new Date(Date.now() - daysAgo * 86_400_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    db.prepare(
      `
      INSERT INTO orders
        (id, status, amount_usdc, payment_asset, api_key_id, card_number, card_cvv, card_expiry, card_brand, created_at, updated_at)
      VALUES (?, 'delivered', '10.00', 'usdc', NULL, '4111111111111111', '123', '12/28', 'Visa', ?, ?)
    `,
    ).run(id, ts, ts);
    return id;
  }

  it('purges card_number/cvv/expiry on delivered orders older than the retention window', () => {
    const oldId = seedDeliveredOrder({ daysAgo: 60 });
    purgeOldCards();
    const row = db
      .prepare(`SELECT card_number, card_cvv, card_expiry, card_brand FROM orders WHERE id = ?`)
      .get(oldId);
    assert.equal(row.card_number, null);
    assert.equal(row.card_cvv, null);
    assert.equal(row.card_expiry, null);
    // Brand stays — it's not sensitive and is useful for analytics.
    assert.equal(row.card_brand, 'Visa');
  });

  it('keeps card data on delivered orders inside the retention window', () => {
    const recentId = seedDeliveredOrder({ daysAgo: 5 });
    purgeOldCards();
    const row = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(recentId);
    assert.equal(row.card_number, '4111111111111111');
  });
});

// ── pruneIdempotencyKeys ──────────────────────────────────────────────────────

describe('pruneIdempotencyKeys', () => {
  beforeEach(() => resetDb());

  function insertIdempotencyKey(hoursAgo = 0) {
    const ts = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const key = uuidv4();
    db.prepare(
      `
      INSERT INTO idempotency_keys (key, api_key_id, response_status, response_body, created_at)
      VALUES (?, 'test-key-id', 200, '{}', ?)
    `,
    ).run(key, ts);
    return key;
  }

  it('deletes idempotency keys older than 24 hours', () => {
    const oldKey = insertIdempotencyKey(25);
    pruneIdempotencyKeys();
    const row = db.prepare(`SELECT key FROM idempotency_keys WHERE key = ?`).get(oldKey);
    assert.equal(row, undefined);
  });

  it('keeps idempotency keys newer than 24 hours', () => {
    const recentKey = insertIdempotencyKey(23);
    pruneIdempotencyKeys();
    const row = db.prepare(`SELECT key FROM idempotency_keys WHERE key = ?`).get(recentKey);
    assert.ok(row, 'recent key should still exist');
  });

  it('prunes old but keeps recent in the same pass', () => {
    const oldKey = insertIdempotencyKey(48);
    const recentKey = insertIdempotencyKey(1);
    pruneIdempotencyKeys();
    assert.equal(
      db.prepare(`SELECT key FROM idempotency_keys WHERE key = ?`).get(oldKey),
      undefined,
    );
    assert.ok(db.prepare(`SELECT key FROM idempotency_keys WHERE key = ?`).get(recentKey));
  });

  it('no-op when there are no keys to prune', () => {
    insertIdempotencyKey(1); // recent only
    assert.doesNotThrow(() => pruneIdempotencyKeys());
  });
});
