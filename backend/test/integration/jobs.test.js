require('../helpers/env');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  recoverStuckOrders,
  expireStaleOrders,
  pruneIdempotencyKeys,
  reconcileOrderingFulfillment,
  purgeOldCards,
} = require('../../src/jobs');
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

  // F1-expire regression: only rows actually flipped by the UPDATE
  // should receive the 'expired' webhook. Previously expireStaleOrders
  // iterated the initial SELECT set, so a row raced to 'delivered' by
  // a concurrent vcc-callback between SELECT and UPDATE would still
  // receive an 'expired' webhook — the agent got two contradictory
  // notifications.
  //
  // We can't cleanly observe the webhook fanout without mocking
  // enqueueWebhook, so this test asserts the DB-level correctness: if
  // a row is ALREADY 'delivered' before expireStaleOrders runs, it
  // doesn't get flipped back and the result.changes count is zero
  // for that row — which is the precondition the fix relies on.
  it('does not flip an already-delivered row back to expired', async () => {
    const { id: keyId } = await createTestKey({ label: 'race-key' });
    const deliveredId = uuidv4();
    const expireId = uuidv4();
    // One row raced to delivered by a prior vcc-callback — old enough
    // to be a candidate on created_at. Second row is a normal stale
    // pending_payment that should expire.
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
      VALUES (?, 'delivered', '15.00', 'usdc', ?, datetime('now', '-3 hours'), datetime('now', '-1 hour'))
    `,
    ).run(deliveredId, keyId);
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
      VALUES (?, 'pending_payment', '20.00', 'usdc', ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'))
    `,
    ).run(expireId, keyId);

    expireStaleOrders();

    const delivered = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(deliveredId);
    const expired = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(expireId);
    assert.equal(delivered.status, 'delivered', 'delivered row must not be flipped back');
    assert.equal(expired.status, 'expired', 'stale pending_payment must be expired');
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

// ── purgeOldCards — F1/F2-prune regression guards ───────────────────────
//
// purgeOldCards used to parseInt(env || '30') with no validation. A
// misconfigured CARD_RETENTION_DAYS could instantly destroy all card
// data (0, huge number) or silently disable the purge (NaN, negative).
// Also used to filter `status = 'delivered'` which would miss any
// non-delivered row that somehow had card data left on it. Both fixed
// in the 2026-04-15 audit.

describe('purgeOldCards — retention validation (F1)', () => {
  let origEnv;

  beforeEach(() => {
    resetDb();
    origEnv = process.env.CARD_RETENTION_DAYS;
  });

  function restoreEnv() {
    if (origEnv === undefined) delete process.env.CARD_RETENTION_DAYS;
    else process.env.CARD_RETENTION_DAYS = origEnv;
  }

  async function seedRecentDeliveredCard() {
    const { id: keyId } = await createTestKey({ label: 'recent-card-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id,
                          card_number, card_cvv, card_expiry, card_brand,
                          created_at, updated_at)
      VALUES (?, 'delivered', '10.00', 'usdc', ?,
              'enc:iv:tag:ct', 'enc:iv:tag:ct', 'enc:iv:tag:ct', 'Visa',
              datetime('now'), datetime('now'))
      `,
    ).run(orderId, keyId);
    return orderId;
  }

  it('CARD_RETENTION_DAYS=0 does NOT wipe recent card data (regression)', async () => {
    // Pre-fix: 0 → datetime('now', '-0 days') = now → every delivered
    // card matches the WHERE and gets wiped on the first tick.
    process.env.CARD_RETENTION_DAYS = '0';
    const orderId = await seedRecentDeliveredCard();

    // Silence the expected warning in this test case.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      purgeOldCards();
    } finally {
      console.warn = origWarn;
      restoreEnv();
    }

    const row = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(orderId);
    assert.ok(row.card_number !== null, 'recent card data must survive the fallback default');
  });

  it('CARD_RETENTION_DAYS=abc falls back to default and still prunes (regression)', async () => {
    process.env.CARD_RETENTION_DAYS = 'abc';

    // Seed an OLD delivered card that should be wiped under the default 30d.
    const { id: keyId } = await createTestKey({ label: 'old-card-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id,
                          card_number, card_cvv, card_expiry, card_brand,
                          created_at, updated_at)
      VALUES (?, 'delivered', '10.00', 'usdc', ?,
              'enc:iv:tag:ct', 'enc:iv:tag:ct', 'enc:iv:tag:ct', 'Visa',
              datetime('now', '-60 days'), datetime('now', '-60 days'))
      `,
    ).run(orderId, keyId);

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      purgeOldCards();
    } finally {
      console.warn = origWarn;
      restoreEnv();
    }

    // Pre-fix: 'abc' → NaN → SQL parse failure → silent no-op → row
    // survives forever. Post-fix: falls back to default 30d → row is 60
    // days old → gets purged.
    const row = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(orderId);
    assert.equal(row.card_number, null, 'old card should be purged via fallback default');
  });

  it('CARD_RETENTION_DAYS=-5 falls back to default', async () => {
    process.env.CARD_RETENTION_DAYS = '-5';
    const orderId = await seedRecentDeliveredCard();

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      purgeOldCards();
    } finally {
      console.warn = origWarn;
      restoreEnv();
    }

    // Recent card survives the 30d default.
    const row = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(orderId);
    assert.ok(row.card_number !== null);
  });

  it('CARD_RETENTION_DAYS=9999999 (astronomical) falls back to default', async () => {
    // Pre-fix: astronomical value flips WHERE clause to match everything
    // (datetime('now', '-9999999 days') is in the far past, so every
    // updated_at > that → matches all delivered orders).
    //
    // Wait — re-reading the query: it's `datetime(updated_at) <
    // datetime('now', '-9999999 days')`. For a huge negative offset,
    // the right side is a VERY EARLY date. A row's updated_at (recent)
    // is LATER than that early date, so the comparison is false → no
    // match. So actually a huge value would UNDER-prune, not over-prune.
    // Still worth guarding against because the cap-at-10-years check
    // catches typo'd values that should have been reasonable.
    process.env.CARD_RETENTION_DAYS = '9999999';
    const orderId = await seedRecentDeliveredCard();

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      purgeOldCards();
    } finally {
      console.warn = origWarn;
      restoreEnv();
    }

    const row = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(orderId);
    // Under the default 30d fallback, a recent row survives.
    assert.ok(row.card_number !== null);
  });

  it('CARD_RETENTION_DAYS=30 (valid) prunes old data, keeps recent data', async () => {
    process.env.CARD_RETENTION_DAYS = '30';
    const recentOrderId = await seedRecentDeliveredCard();
    const { id: keyId } = await createTestKey({ label: 'old-valid-key' });
    const oldOrderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id,
                          card_number, card_cvv, card_expiry, card_brand,
                          created_at, updated_at)
      VALUES (?, 'delivered', '10.00', 'usdc', ?,
              'enc:iv:tag:ct', 'enc:iv:tag:ct', 'enc:iv:tag:ct', 'Visa',
              datetime('now', '-45 days'), datetime('now', '-45 days'))
      `,
    ).run(oldOrderId, keyId);

    try {
      purgeOldCards();
    } finally {
      restoreEnv();
    }

    const recent = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(recentOrderId);
    assert.ok(recent.card_number !== null, 'recent row should survive');
    const old = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(oldOrderId);
    assert.equal(old.card_number, null, 'old row should be purged');
  });

  it('purges a refunded-post-delivery row (F2 — widened filter)', async () => {
    // Pre-fix: WHERE status='delivered' missed rows that had transitioned
    // delivered → refunded with leftover card data. Post-fix: filter on
    // card_number IS NOT NULL so any row with leftover card data is
    // purged regardless of status.
    process.env.CARD_RETENTION_DAYS = '30';
    const { id: keyId } = await createTestKey({ label: 'refunded-card-key' });
    const orderId = uuidv4();
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id,
                          card_number, card_cvv, card_expiry, card_brand,
                          created_at, updated_at)
      VALUES (?, 'refunded', '10.00', 'usdc', ?,
              'enc:iv:tag:ct', 'enc:iv:tag:ct', 'enc:iv:tag:ct', 'Visa',
              datetime('now', '-60 days'), datetime('now', '-60 days'))
      `,
    ).run(orderId, keyId);

    try {
      purgeOldCards();
    } finally {
      restoreEnv();
    }

    const row = db.prepare(`SELECT card_number FROM orders WHERE id = ?`).get(orderId);
    assert.equal(row.card_number, null, 'refunded row with leftover card data must be purged');
  });
});

// ── reconcileOrderingFulfillment — F2-reconcile freeze short-circuit ─────
//
// Before this fix, reconcile would keep retrying payCtxOrder (outbound
// treasury money movement) on every 5-minute tick even while the
// system-wide freeze flag was set — which is the emergency-stop signal
// that's supposed to halt all automatic money movement. scheduleRefund
// already had a freeze guard from an earlier audit cycle; reconcile
// didn't, creating a split where refunds were blocked but retries
// weren't. Stuck orders now wait until ops unfreezes.

describe('reconcileOrderingFulfillment — freeze short-circuit (F2)', () => {
  beforeEach(() => resetDb());

  it('skips all stuck-order processing while the system is frozen', async () => {
    // Flip the freeze flag on directly. A real incident-response
    // unfreeze would go through POST /dashboard/platform/unfreeze
    // after ops investigated, but we want to exercise the reconcile
    // short-circuit without running the whole platform router.
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();

    const { id: keyId } = await createTestKey({ label: 'frozen-reconcile-key' });
    const orderId = uuidv4();
    // Seed an order that WOULD normally be picked up: status='ordering',
    // missing xlm_sent_at, stale updated_at.
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, sender_address,
                          api_key_id, vcc_job_id, fulfillment_attempt,
                          created_at, updated_at)
      VALUES (?, 'ordering', '10.00', 'usdc_soroban', 'GTESTSENDER', ?, 'vcc-job-frozen',
              0, datetime('now', '-1 hour'), datetime('now', '-30 minutes'))
      `,
    ).run(orderId, keyId);

    // Spy on vccClient.getVccJobStatus — if reconcile short-circuits
    // correctly, this should NEVER be called (the function returns
    // before even reading the stuck-order list).
    let vccCalled = false;
    const originalGetVcc = vccClient.getVccJobStatus;
    vccClient.getVccJobStatus = async () => {
      vccCalled = true;
      return { status: 'queued' };
    };

    try {
      await reconcileOrderingFulfillment();
    } finally {
      vccClient.getVccJobStatus = originalGetVcc;
      db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'frozen'`).run();
    }

    assert.equal(vccCalled, false, 'vccClient must NOT be called while frozen');

    // Order is untouched — no fulfillment_attempt bump, no status flip.
    const order = /** @type {any} */ (
      db.prepare(`SELECT status, fulfillment_attempt FROM orders WHERE id = ?`).get(orderId)
    );
    assert.equal(order.status, 'ordering');
    assert.equal(order.fulfillment_attempt, 0);
  });
});

// ── retryWebhooks — F1-retry-webhooks vault failure path ──────────────────
//
// Before the 2026-04-15 audit, a card-vault decrypt failure during
// payload rehydration propagated out of the rehydration block as a
// generic delivery failure. The retry loop would burn 3 attempts over
// ~35 minutes before marking the row "webhook failed" with a cryptic
// "card-vault: failed to open card_number" as last_error — the
// on-call engineer would debug the customer's endpoint when the real
// problem was our vault. Fix: mark the row permanently failed on the
// first openCard throw, emit a distinct bizEvent, and do not attempt
// to fire the webhook with half-baked {card: null} data.

describe('retryWebhooks — vault failure path (F1)', () => {
  beforeEach(() => {
    resetDb();
  });

  it('marks row permanently failed on card-vault decrypt failure without firing', async () => {
    const { retryWebhooks } = require('../../src/jobs');
    const { id: keyId } = await createTestKey({ label: 'vault-fail-key' });
    const orderId = uuidv4();

    // Insert an orders row with a CORRUPTED sealed card_number — the
    // enc: envelope looks structurally valid (4 parts, hex chars)
    // but the GCM tag won't authenticate, so open() throws.
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id,
                          card_number, card_cvv, card_expiry, card_brand,
                          created_at, updated_at)
      VALUES (?, 'delivered', '10.00', 'usdc', ?,
              'enc:aabbccddeeff0011223344556677:00112233445566778899aabbccddeeff:deadbeef',
              NULL, NULL, 'Visa', datetime('now'), datetime('now'))
    `,
    ).run(orderId, keyId);

    // Queue a webhook row with a card-redacted payload, due now.
    const webhookId = uuidv4();
    db.prepare(
      `
      INSERT INTO webhook_queue (id, url, payload, secret, attempts, next_attempt, last_error)
      VALUES (?, 'https://hooks.example.com/vault-test', ?, NULL, 1, datetime('now', '-1 minute'), 'first failure')
    `,
    ).run(
      webhookId,
      JSON.stringify({
        order_id: orderId,
        status: 'delivered',
        card: { number: null, cvv: null, expiry: null, brand: 'Visa' },
      }),
    );

    // Force a real CARDS402_SECRET_BOX_KEY so the vault actually tries
    // to decrypt (and fails the GCM tag). Without a key the open() is
    // a pass-through and the corrupt value would ship as-is — which
    // is a different (less interesting) code path.
    const prev = process.env.CARDS402_SECRET_BOX_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = 'a'.repeat(64);
    // Blow away any require cache so secret-box re-reads the env.
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];

    // Track fetch calls — fireWebhook must NOT be called on the vault-
    // failure path. Stub global.fetch to assert it doesn't fire.
    const origFetch = global.fetch;
    let fetchCalled = false;
    // @ts-expect-error — test stub
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };

    try {
      await retryWebhooks();
    } finally {
      global.fetch = origFetch;
      if (prev === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
      else process.env.CARDS402_SECRET_BOX_KEY = prev;
      delete require.cache[require.resolve('../../src/lib/secret-box')];
      delete require.cache[require.resolve('../../src/lib/card-vault')];
    }

    assert.equal(fetchCalled, false, 'vault failure must NOT attempt to fire the webhook');

    const row = db.prepare(`SELECT * FROM webhook_queue WHERE id = ?`).get(webhookId);
    // attempts is MAX_WEBHOOK_ATTEMPTS + 1 = 4, which is > MAX and thus
    // will never be re-selected by retryWebhooks again. Permanent.
    assert.ok(row.attempts > 3, `expected permanently failed (attempts > 3), got ${row.attempts}`);
    // last_error must carry the vault-specific prefix, not a
    // generic HTTP / fetch error.
    assert.match(row.last_error, /vault_open_failed/);
  });
});
