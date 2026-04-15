// Unit tests for lib/stats.js — the shared order aggregation helper
// consumed by /internal/stats. Previously zero direct coverage.
//
// Locks in the 2026-04-15 audit fixes:
//   F1  total_gmv counts delivered orders only (no longer inflated
//       by failed / expired / rejected / refunded attempts)
//   F2  explicit empty-scope (apiKeyIds: []) returns zero without
//       hitting the DB — closes the cross-tenant leak where an
//       empty filter fell through to the platform totals
//   F3  every COUNT/SUM COALESCE-wrapped so an empty table returns
//       zero instead of null for the detail counters
//   F4  in_progress bucket covers the ordering-family statuses

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, createTestKey, resetDb } = require('../helpers/app');
const { getOrderStats } = require('../../src/lib/stats');

function seed(fields) {
  db.prepare(
    `
    INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
    VALUES (@id, @status, @amount, 'usdc', @api_key_id, datetime('now'), datetime('now'))
  `,
  ).run({
    id: uuidv4(),
    status: fields.status,
    amount: fields.amount,
    api_key_id: fields.api_key_id,
  });
}

describe('getOrderStats — empty DB (F3)', () => {
  beforeEach(() => resetDb());

  it('returns zero for every counter on an empty orders table', () => {
    const s = getOrderStats();
    assert.equal(s.total_orders, 0);
    assert.equal(s.total_gmv, 0);
    assert.equal(s.delivered, 0);
    assert.equal(s.failed, 0);
    assert.equal(s.refunded, 0);
    assert.equal(s.pending, 0);
    assert.equal(s.in_progress, 0);
    assert.equal(s.refund_pending, 0);
  });

  it('does not return null for any counter (NaN defence)', () => {
    const s = getOrderStats();
    for (const k of Object.keys(s)) {
      assert.equal(typeof s[k], 'number', `${k} must be a number, got ${typeof s[k]}`);
      assert.ok(!Number.isNaN(s[k]), `${k} must not be NaN`);
    }
  });
});

describe('getOrderStats — total_gmv scope (F1)', () => {
  let key;

  beforeEach(async () => {
    resetDb();
    key = await createTestKey({ label: 'gmv-key' });
  });

  it('counts delivered order amounts in total_gmv', () => {
    seed({ status: 'delivered', amount: '25.00', api_key_id: key.id });
    seed({ status: 'delivered', amount: '10.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.delivered, 2);
    assert.equal(s.total_gmv, 35);
  });

  it('EXCLUDES failed orders from total_gmv (F1 regression)', () => {
    seed({ status: 'delivered', amount: '10.00', api_key_id: key.id });
    seed({ status: 'failed', amount: '50.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.delivered, 1);
    assert.equal(s.failed, 1);
    // Pre-fix this would have been 60. Post-fix: just the delivered $10.
    assert.equal(s.total_gmv, 10);
  });

  it('EXCLUDES expired orders from total_gmv', () => {
    seed({ status: 'delivered', amount: '15.00', api_key_id: key.id });
    seed({ status: 'expired', amount: '1000.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.total_gmv, 15);
  });

  it('EXCLUDES refunded orders from total_gmv (refunded = net zero)', () => {
    seed({ status: 'delivered', amount: '20.00', api_key_id: key.id });
    seed({ status: 'refunded', amount: '100.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.delivered, 1);
    assert.equal(s.refunded, 1);
    assert.equal(s.total_gmv, 20);
  });

  it('EXCLUDES rejected orders from total_gmv', () => {
    seed({ status: 'delivered', amount: '5.00', api_key_id: key.id });
    seed({ status: 'rejected', amount: '500.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.total_gmv, 5);
  });

  it('still counts all orders in total_orders (regardless of status)', () => {
    seed({ status: 'delivered', amount: '10.00', api_key_id: key.id });
    seed({ status: 'failed', amount: '10.00', api_key_id: key.id });
    seed({ status: 'expired', amount: '10.00', api_key_id: key.id });
    seed({ status: 'rejected', amount: '10.00', api_key_id: key.id });
    seed({ status: 'refunded', amount: '10.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.total_orders, 5);
    assert.equal(s.total_gmv, 10); // only delivered
  });
});

describe('getOrderStats — empty scope (F2)', () => {
  let key;

  beforeEach(async () => {
    resetDb();
    key = await createTestKey({ label: 'scope-key' });
    // Seed some rows so we can prove the scope isolates them.
    seed({ status: 'delivered', amount: '50.00', api_key_id: key.id });
    seed({ status: 'delivered', amount: '25.00', api_key_id: key.id });
  });

  it('returns zero for apiKeyIds: [] — does NOT fall through to global totals', () => {
    // Pre-fix: this returned { total_orders: 2, total_gmv: 75, ... }
    // because the apiKeyIds.length > 0 guard fell through to an
    // unscoped query. Post-fix: short-circuits to zero.
    const s = getOrderStats({ apiKeyIds: [] });
    assert.equal(s.total_orders, 0);
    assert.equal(s.total_gmv, 0);
    assert.equal(s.delivered, 0);
  });

  it('returns scoped stats when apiKeyIds has one entry', () => {
    const s = getOrderStats({ apiKeyIds: [key.id] });
    assert.equal(s.total_orders, 2);
    assert.equal(s.delivered, 2);
    assert.equal(s.total_gmv, 75);
  });

  it('returns platform totals when apiKeyIds is undefined (unchanged)', () => {
    const s = getOrderStats();
    assert.equal(s.total_orders, 2);
  });
});

describe('getOrderStats — in_progress bucket (F4)', () => {
  let key;

  beforeEach(async () => {
    resetDb();
    key = await createTestKey({ label: 'inprog-key' });
  });

  it('counts ordering-family statuses as in_progress', () => {
    seed({ status: 'ordering', amount: '10.00', api_key_id: key.id });
    seed({ status: 'payment_confirmed', amount: '10.00', api_key_id: key.id });
    seed({ status: 'claim_received', amount: '10.00', api_key_id: key.id });
    seed({ status: 'stage1_done', amount: '10.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.in_progress, 4);
    assert.equal(s.pending, 0, 'pending_payment is a separate bucket');
  });

  it('keeps pending_payment distinct from in_progress', () => {
    seed({ status: 'pending_payment', amount: '10.00', api_key_id: key.id });
    seed({ status: 'ordering', amount: '10.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.pending, 1);
    assert.equal(s.in_progress, 1);
  });
});

// ── F5-stats: dedicated buckets for expired / rejected / awaiting_approval ──
//
// Pre-fix these statuses were counted in total_orders but missing from
// the per-status breakdown, so the sum of detail buckets was strictly
// less than total_orders whenever any order was in one of these states.
// Post-fix they have their own fields and the sum-invariant holds.

describe('getOrderStats — F5 missing-bucket coverage', () => {
  let key;

  beforeEach(async () => {
    resetDb();
    key = await createTestKey({ label: 'missing-bucket' });
  });

  it('counts expired orders in the expired bucket', () => {
    seed({ status: 'expired', amount: '10.00', api_key_id: key.id });
    seed({ status: 'expired', amount: '20.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.expired, 2);
    // Regression guards: expired must NOT leak into other buckets.
    assert.equal(s.failed, 0);
    assert.equal(s.pending, 0);
    assert.equal(s.in_progress, 0);
  });

  it('counts rejected orders in the rejected bucket', () => {
    seed({ status: 'rejected', amount: '10.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.rejected, 1);
    assert.equal(s.failed, 0);
  });

  it('counts awaiting_approval orders in the awaiting_approval bucket', () => {
    seed({ status: 'awaiting_approval', amount: '10.00', api_key_id: key.id });
    seed({ status: 'awaiting_approval', amount: '20.00', api_key_id: key.id });
    seed({ status: 'awaiting_approval', amount: '30.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.awaiting_approval, 3);
    assert.equal(s.in_progress, 0);
    assert.equal(s.pending, 0);
  });

  it('emptyStats() returns zero for every new bucket', () => {
    const s = getOrderStats({ apiKeyIds: [] });
    assert.equal(s.expired, 0);
    assert.equal(s.rejected, 0);
    assert.equal(s.awaiting_approval, 0);
  });

  it('bucket-sum invariant: total_orders equals sum of every detail bucket', () => {
    // Seed one of every live status + some variety. Post-fix, summing
    // all detail buckets equals total_orders exactly. Pre-fix, expired
    // + rejected + awaiting_approval would have been lost and the sum
    // would have been (total_orders - 3).
    seed({ status: 'delivered', amount: '10.00', api_key_id: key.id });
    seed({ status: 'failed', amount: '10.00', api_key_id: key.id });
    seed({ status: 'refunded', amount: '10.00', api_key_id: key.id });
    seed({ status: 'pending_payment', amount: '10.00', api_key_id: key.id });
    seed({ status: 'ordering', amount: '10.00', api_key_id: key.id });
    seed({ status: 'refund_pending', amount: '10.00', api_key_id: key.id });
    seed({ status: 'expired', amount: '10.00', api_key_id: key.id });
    seed({ status: 'rejected', amount: '10.00', api_key_id: key.id });
    seed({ status: 'awaiting_approval', amount: '10.00', api_key_id: key.id });
    const s = getOrderStats();
    assert.equal(s.total_orders, 9);
    const bucketSum =
      s.delivered +
      s.failed +
      s.refunded +
      s.pending +
      s.in_progress +
      s.refund_pending +
      s.expired +
      s.rejected +
      s.awaiting_approval;
    assert.equal(
      bucketSum,
      s.total_orders,
      `bucket sum ${bucketSum} != total_orders ${s.total_orders} — a live status is unaccounted for`,
    );
  });
});

// ── F6-stats: non-array apiKeyIds surfaces a clear error ────────────────────
//
// Pre-fix a caller passing a string (e.g. 'abc') fell through the empty
// check, entered the `.length > 0` branch, and crashed on `.map is not a
// function` — a confusing TypeError leaking from deep inside the SQL
// builder. Post-fix the shape check at the boundary throws a clear
// TypeError that points at the offending parameter.

describe('getOrderStats — F6 apiKeyIds type validation', () => {
  beforeEach(() => resetDb());

  it('throws TypeError when apiKeyIds is a string (regression guard)', () => {
    assert.throws(
      // @ts-expect-error — intentional
      () => getOrderStats({ apiKeyIds: 'abc' }),
      /apiKeyIds must be an array/,
    );
  });

  it('throws TypeError when apiKeyIds is a number', () => {
    assert.throws(
      // @ts-expect-error — intentional
      () => getOrderStats({ apiKeyIds: 42 }),
      /apiKeyIds must be an array/,
    );
  });

  it('throws TypeError when apiKeyIds is a plain object', () => {
    assert.throws(
      // @ts-expect-error — intentional
      () => getOrderStats({ apiKeyIds: { id: 'x' } }),
      /apiKeyIds must be an array/,
    );
  });

  it('accepts undefined apiKeyIds (regression guard for the default platform scope)', () => {
    // Should NOT throw — undefined is the documented "all keys" mode.
    const s = getOrderStats();
    assert.equal(typeof s.total_orders, 'number');
  });
});

// ── F7-stats: apiKeyIds length cap ──────────────────────────────────────────
//
// SQLite's default SQLITE_LIMIT_VARIABLE_NUMBER is 32766; beyond ~1k
// ids we'd be burning memory on a multi-megabyte SQL string that would
// eventually crash the bind. Cap at MAX_SCOPE_IDS=1000 — far beyond any
// realistic dashboard scope — and throw a clear RangeError BEFORE
// building the IN clause.

describe('getOrderStats — F7 scope-size cap', () => {
  beforeEach(() => resetDb());

  it('accepts a scope of exactly MAX_SCOPE_IDS (1000) without throwing', () => {
    const ids = [];
    for (let i = 0; i < 1000; i++) ids.push(`k-${i}`);
    // No real rows match — we're proving the query builds and runs,
    // not that it returns anything meaningful.
    const s = getOrderStats({ apiKeyIds: ids });
    assert.equal(s.total_orders, 0);
  });

  it('throws RangeError when apiKeyIds exceeds MAX_SCOPE_IDS', () => {
    const ids = [];
    for (let i = 0; i < 1001; i++) ids.push(`k-${i}`);
    assert.throws(() => getOrderStats({ apiKeyIds: ids }), /exceeds MAX_SCOPE_IDS/);
  });

  it('includes the offending length in the error message', () => {
    const ids = [];
    for (let i = 0; i < 5000; i++) ids.push(`k-${i}`);
    try {
      getOrderStats({ apiKeyIds: ids });
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /5000/);
    }
  });
});
