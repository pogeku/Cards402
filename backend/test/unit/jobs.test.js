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

// ── F1-jobs (2026-04-15): ambiguous CTX payment parking ────────────────
//
// The critical safety property: an outbound payCtxOrder tx that might
// have landed during a lost-response window (stellarStatus='unknown'
// or 'applied_failed') must NOT be retried by the reconciler — a
// second tx with the same net effect would double-spend treasury.
// These tests pin both sides of the contract:
//
//   (a) The reconciler SELECT excludes rows with ctx_stellar_txid set
//       (parked by a prior attempt).
//   (b) When the reconciler's own payCtxOrder retry throws with the
//       ambiguous-outcome markers, it parks the row instead of leaving
//       it for another retry.

describe('reconcileOrderingFulfillment — F1 ambiguous CTX payment parking', () => {
  const { reconcileOrderingFulfillment } = require('../../src/jobs');
  const xlmSender = require('../../src/payments/xlm-sender');
  const realPayCtxOrder = xlmSender.payCtxOrder;

  beforeEach(() => {
    resetDb();
    // Default: make xlm-sender succeed if called so tests that aren't
    // about the ambiguous path don't have to mock it.
    xlmSender.payCtxOrder = async () => 'SUCCESS_HASH';
    // Default vcc status = invoice_issued so the retry path runs
    // payCtxOrder rather than skipping it.
    vccClient.getVccJobStatus = async () => ({
      status: 'invoice_issued',
      payment_url: 'stellar:pay?destination=G...',
    });
    vccClient.getInvoice = async () => ({
      vccJobId: 'vcc-test',
      paymentUrl: 'stellar:pay?destination=G...',
      callbackNonce: 'nonce-test',
    });
    vccClient.notifyPaid = async () => {};
  });

  function stopPatching() {
    xlmSender.payCtxOrder = realPayCtxOrder;
  }

  function makeAmbiguousError(stellarStatus, hash) {
    const err = /** @type {any} */ (new Error('submit network error'));
    err.stellarStatus = stellarStatus;
    err.txHash = hash;
    return err;
  }

  function seedStuckOrdering({ minutesAgo = 10, ctx_stellar_txid = null } = {}) {
    const id = uuidv4();
    // Use .toISOString() directly — the reconciler stores timestamps in
    // that format via `new Date().toISOString()`, and its `updated_at < ?`
    // comparator is a raw string compare (not SQLite datetime()). The
    // older "YYYY-MM-DD HH:MM:SS" seed format from other tests in this
    // file sorts differently at position 10 (space < T), which makes the
    // seeded row look permanently stale and diverts it to the hard-fail
    // postpone branch before the retry path can run.
    const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO orders (
        id, status, amount_usdc, payment_asset, api_key_id,
        vcc_job_id, xlm_sent_at, vcc_notified_at,
        fulfillment_attempt, ctx_stellar_txid,
        created_at, updated_at
      ) VALUES (?, 'ordering', '10.00', 'usdc_soroban', NULL,
        'vcc-job', NULL, NULL, 0, ?, ?, ?)`,
    ).run(id, ctx_stellar_txid, ts, ts);
    return id;
  }

  it('SELECT skips rows that already have ctx_stellar_txid set (parked)', async () => {
    // Seed a parked row — prior attempt captured hash 'abc' and is
    // waiting on ops verification. The reconciler must NOT pick it up
    // even though xlm_sent_at is still NULL.
    const id = seedStuckOrdering({ ctx_stellar_txid: 'parked-hash-abc' });

    let payCalls = 0;
    xlmSender.payCtxOrder = async () => {
      payCalls += 1;
      return 'UNEXPECTED_HASH';
    };
    await reconcileOrderingFulfillment();
    stopPatching();

    assert.equal(payCalls, 0, 'reconciler must NOT retry a parked row');
    const row = db.prepare(`SELECT status, ctx_stellar_txid FROM orders WHERE id = ?`).get(id);
    assert.equal(row.ctx_stellar_txid, 'parked-hash-abc', 'hash must be preserved');
    assert.equal(row.status, 'ordering', 'status untouched by the skipped reconciler');
  });

  it('parks the order on retry-side stellarStatus=unknown (tx may have landed)', async () => {
    const AMBIGUOUS_HASH = 'a'.repeat(64);
    const id = seedStuckOrdering();

    xlmSender.payCtxOrder = async () => {
      throw makeAmbiguousError('unknown', AMBIGUOUS_HASH);
    };
    await reconcileOrderingFulfillment();
    stopPatching();

    const row = db
      .prepare(`SELECT status, error, ctx_stellar_txid, xlm_sent_at FROM orders WHERE id = ?`)
      .get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.ctx_stellar_txid, AMBIGUOUS_HASH);
    // Critical: xlm_sent_at must stay NULL so a schema-only audit still
    // shows "we don't know if this paid" — but ctx_stellar_txid IS set,
    // so the reconciler's SELECT filter skips future retries.
    assert.equal(row.xlm_sent_at, null);
    // The public error must be the payment_pending_review message, NOT
    // the generic "refunded automatically" lie.
    assert.match(row.error, /ambiguous on-chain state|operator/i);
    assert.doesNotMatch(row.error, /refunded automatically/i);
  });

  it('parks on retry-side stellarStatus=applied_failed (tx landed but failed on chain)', async () => {
    // When the tx landed and failed, the sequence is consumed but
    // treasury wasn't debited for the payment. This case must also
    // park — retrying would succeed with a new sequence and THEN
    // become a double-spend if ops subsequently re-issues from chain.
    const FAILED_HASH = 'b'.repeat(64);
    const id = seedStuckOrdering();

    xlmSender.payCtxOrder = async () => {
      throw makeAmbiguousError('applied_failed', FAILED_HASH);
    };
    await reconcileOrderingFulfillment();
    stopPatching();

    const row = db.prepare(`SELECT status, ctx_stellar_txid FROM orders WHERE id = ?`).get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.ctx_stellar_txid, FAILED_HASH);
  });

  it('non-ambiguous error (no stellarStatus marker) leaves row in ordering for attempt-counter retry', async () => {
    // A legacy throw with no markers should follow the existing
    // attempt-counter/timeout logic — status stays 'ordering' so the
    // next reconciler tick can retry. Must NOT persist a txHash
    // (there isn't one) and must NOT park.
    const id = seedStuckOrdering();

    xlmSender.payCtxOrder = async () => {
      throw new Error('opaque horizon error');
    };
    await reconcileOrderingFulfillment();
    stopPatching();

    const row = db.prepare(`SELECT status, ctx_stellar_txid FROM orders WHERE id = ?`).get(id);
    assert.equal(row.status, 'ordering');
    assert.equal(row.ctx_stellar_txid, null);
  });

  it('successful retry persists the returned hash to ctx_stellar_txid', async () => {
    // Not strictly a safety test but pins the forensic-hash capture on
    // the success path: if a retry lands cleanly we want to see the
    // hash on the orders row for audit.
    const id = seedStuckOrdering();

    xlmSender.payCtxOrder = async () => 'HAPPY_RETRY_HASH';
    await reconcileOrderingFulfillment();
    stopPatching();

    const row = db.prepare(`SELECT xlm_sent_at, ctx_stellar_txid FROM orders WHERE id = ?`).get(id);
    assert.ok(row.xlm_sent_at, 'xlm_sent_at should be set on success');
    assert.equal(row.ctx_stellar_txid, 'HAPPY_RETRY_HASH');
  });
});
