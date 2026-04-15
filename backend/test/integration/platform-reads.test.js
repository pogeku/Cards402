// Integration tests for the read-only /dashboard/platform/* endpoints.
//
// Before the adversarial-audit fixes in this cycle there were no
// integration tests for /platform/orders or /platform/audit despite
// both being routinely used by the operator console UI. This file
// pins:
//
//   F1 — Query-param shape validation on /platform/orders. A
//        repeated ?status=a&status=b (and same for dashboard_id,
//        api_key_id) must return 400 invalid_query_param instead of
//        silently coercing to "a,b" and returning an empty list.
//
//   F2 — /platform/audit returns `details` as a parsed object,
//        matching the contract of lib/audit.js::listAudit which
//        backs /dashboard/audit-log. UI clients hitting both
//        endpoints should see the same shape for this column.
//
// Plus one regression guard for each endpoint's happy path.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  request,
  db,
  createTestSession,
  resetDb,
  createTestKey,
  seedOrder,
} = require('../helpers/app');
const { recordAudit } = require('../../src/lib/audit');

const PLATFORM_OWNER_EMAIL = 'platform-owner@cards402.test';

function platformAuth() {
  const { token } = createTestSession({ email: PLATFORM_OWNER_EMAIL });
  return `Bearer ${token}`;
}

// ── GET /dashboard/platform/orders ─────────────────────────────────────

describe('GET /dashboard/platform/orders — F1 query param shape', () => {
  let origOwnerEnv;
  beforeEach(() => {
    resetDb();
    origOwnerEnv = process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = PLATFORM_OWNER_EMAIL;
  });
  afterEach(() => {
    if (origOwnerEnv === undefined) delete process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    else process.env.CARDS402_PLATFORM_OWNER_EMAIL = origOwnerEnv;
  });

  it('rejects array status with 400 (F1)', async () => {
    const res = await request
      .get('/dashboard/platform/orders?status=a&status=b')
      .set('Authorization', platformAuth());
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_query_param');
    assert.match(res.body.message, /status/);
  });

  it('rejects array dashboard_id with 400 (F1)', async () => {
    const res = await request
      .get('/dashboard/platform/orders?dashboard_id=x&dashboard_id=y')
      .set('Authorization', platformAuth());
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_query_param');
    assert.match(res.body.message, /dashboard_id/);
  });

  it('rejects array api_key_id with 400 (F1)', async () => {
    const res = await request
      .get('/dashboard/platform/orders?api_key_id=k1&api_key_id=k2')
      .set('Authorization', platformAuth());
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_query_param');
    assert.match(res.body.message, /api_key_id/);
  });

  it('happy path: returns matching orders with owning dashboard + agent metadata', async () => {
    const apiKey = await createTestKey({ label: 'platform-reads' });
    const orderId = seedOrder({
      api_key_id: apiKey.id,
      status: 'delivered',
      amount_usdc: '7.50',
    });

    const res = await request
      .get('/dashboard/platform/orders')
      .set('Authorization', platformAuth());
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const row = res.body.find((r) => r.id === orderId);
    assert.ok(row, 'seeded order must appear in cross-tenant list');
    assert.equal(row.status, 'delivered');
    assert.equal(row.amount_usdc, '7.50');
    assert.equal(row.api_key_label, 'platform-reads');
    // Cross-tenant join columns exist on the row.
    assert.ok('dashboard_id' in row);
    assert.ok('owner_email' in row);
  });

  it('accepts a single ?status filter and narrows the result set', async () => {
    const apiKey = await createTestKey({ label: 'single-status' });
    const delivered = seedOrder({ api_key_id: apiKey.id, status: 'delivered' });
    const failed = seedOrder({ api_key_id: apiKey.id, status: 'failed' });

    const res = await request
      .get('/dashboard/platform/orders?status=delivered')
      .set('Authorization', platformAuth());
    assert.equal(res.status, 200);
    const ids = res.body.map((r) => r.id);
    assert.ok(ids.includes(delivered));
    assert.ok(!ids.includes(failed));
  });
});

// ── GET /dashboard/platform/audit ──────────────────────────────────────

describe('GET /dashboard/platform/audit — F2 details parsing', () => {
  let origOwnerEnv;
  beforeEach(() => {
    resetDb();
    origOwnerEnv = process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = PLATFORM_OWNER_EMAIL;
  });
  afterEach(() => {
    if (origOwnerEnv === undefined) delete process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    else process.env.CARDS402_PLATFORM_OWNER_EMAIL = origOwnerEnv;
  });

  function seedAuditRow(details) {
    // Use the recordAudit helper so the row goes through the same
    // serialisation path the production code uses.
    recordAudit({
      dashboardId: 'system',
      actor: { id: null, email: 'test-actor@cards402.com', role: 'owner' },
      action: 'platform.test_event',
      resourceType: 'system',
      resourceId: 'platform_reads_test',
      details,
      ip: '127.0.0.1',
      userAgent: 'test-ua',
    });
  }

  it('returns details as a parsed object, not a JSON string (F2)', async () => {
    // Pre-fix: the endpoint returned { ..., details: "{\"reason\":\"x\"}" }
    // as a raw JSON string, inconsistent with lib/audit.js::listAudit
    // which parses it. Post-fix the two code paths return the same
    // shape for this column.
    seedAuditRow({ reason: 'platform_reads_test', count: 42, nested: { ok: true } });

    const res = await request.get('/dashboard/platform/audit').set('Authorization', platformAuth());
    assert.equal(res.status, 200);
    const row = res.body.find((r) => r.resource_id === 'platform_reads_test');
    assert.ok(row, 'seeded audit row must appear in the list');
    // The critical property: details is an object, not a string.
    assert.equal(
      typeof row.details,
      'object',
      'details must be parsed into an object, not returned as JSON text',
    );
    assert.equal(row.details.reason, 'platform_reads_test');
    assert.equal(row.details.count, 42);
    assert.deepEqual(row.details.nested, { ok: true });
  });

  it('returns null details as null (not "null" string)', async () => {
    seedAuditRow(undefined);

    const res = await request.get('/dashboard/platform/audit').set('Authorization', platformAuth());
    const row = res.body.find((r) => r.resource_id === 'platform_reads_test');
    assert.ok(row);
    assert.equal(row.details, null);
  });

  it('falls back to the raw string on a non-JSON details column (forward-compat)', async () => {
    // Insert a row directly with a non-JSON details value to simulate
    // a hand-migration or legacy producer. safeParseJson() should
    // swallow the throw and return the raw string — the audit row
    // must still appear in the response rather than being dropped.
    db.prepare(
      `INSERT INTO audit_log (dashboard_id, actor_user_id, actor_email, actor_role,
                              action, resource_type, resource_id, details, ip, user_agent)
       VALUES ('system', NULL, 'legacy@cards402.com', 'owner',
               'platform.legacy_event', 'system', 'legacy_raw', 'not-valid-json',
               '127.0.0.1', 'ua')`,
    ).run();

    const res = await request.get('/dashboard/platform/audit').set('Authorization', platformAuth());
    const row = res.body.find((r) => r.resource_id === 'legacy_raw');
    assert.ok(row, 'legacy row must not be dropped on parse failure');
    assert.equal(row.details, 'not-valid-json');
  });
});
