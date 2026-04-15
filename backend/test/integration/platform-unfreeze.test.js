// Integration tests for POST /dashboard/platform/unfreeze.
//
// This is cards402's only platform-scoped mutation and it lifts the
// system-wide freeze (resumes treasury outflows + clears the circuit
// breaker). The 2026-04-15 audit required that every unfreeze:
//
//   1. Be gated by requirePlatformOwner (403 for anyone else).
//   2. Require a `reason` field of at least 10 characters so the
//      audit trail captures why the freeze was lifted.
//   3. Write to BOTH admin_actions AND the unified audit_log via
//      the hardened recordAudit helper.
//   4. Emit a platform.unfreeze bizEvent.
//   5. Succeed even if the DB writes partially fail (incident-
//      response must not depend on DB liveness) — but this path
//      isn't directly testable without corrupting the schema, so
//      we just exercise the happy path + rejection path here.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { request, db, createTestSession, resetDb } = require('../helpers/app');

const PLATFORM_OWNER_EMAIL = 'platform-owner@cards402.test';

describe('POST /dashboard/platform/unfreeze', () => {
  let origOwnerEnv;

  beforeEach(() => {
    resetDb();
    origOwnerEnv = process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = PLATFORM_OWNER_EMAIL;
    // Start each case with the platform already frozen so we can
    // observe the unfreeze take effect.
    db.prepare(`INSERT OR REPLACE INTO system_state (key, value) VALUES ('frozen', '1')`).run();
    db.prepare(
      `INSERT OR REPLACE INTO system_state (key, value) VALUES ('consecutive_failures', '5')`,
    ).run();
  });

  afterEach(() => {
    if (origOwnerEnv === undefined) delete process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    else process.env.CARDS402_PLATFORM_OWNER_EMAIL = origOwnerEnv;
  });

  it('rejects without a session (401)', async () => {
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .send({ reason: 'incident 42 resolved' });
    assert.equal(res.status, 401);
    // Frozen state unchanged.
    const frozen = db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get();
    assert.equal(frozen.value, '1');
  });

  it('rejects a non-platform-owner session (403)', async () => {
    const { token } = createTestSession({ email: 'some-tenant@example.com' });
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'just testing please let me in' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
    // Frozen state unchanged.
    const frozen = db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get();
    assert.equal(frozen.value, '1');
  });

  it('rejects missing reason (400 reason_required)', async () => {
    const { token } = createTestSession({ email: PLATFORM_OWNER_EMAIL });
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'reason_required');
    // Frozen state unchanged.
    const frozen = db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get();
    assert.equal(frozen.value, '1');
  });

  it('rejects a too-short reason (< 10 chars)', async () => {
    const { token } = createTestSession({ email: PLATFORM_OWNER_EMAIL });
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'reason_required');
  });

  it('rejects a whitespace-only reason', async () => {
    const { token } = createTestSession({ email: PLATFORM_OWNER_EMAIL });
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '             ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'reason_required');
  });

  it('unfreezes with a valid reason and records to both audit tables', async () => {
    const { token } = createTestSession({ email: PLATFORM_OWNER_EMAIL });
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'incident 42 resolved — CTX back online' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.frozen, false);

    // system_state.frozen flipped to '0'.
    const frozen = db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get();
    assert.equal(frozen.value, '0');

    // consecutive_failures cleared.
    const failures = db
      .prepare(`SELECT value FROM system_state WHERE key = 'consecutive_failures'`)
      .get();
    assert.equal(failures.value, '0');

    // admin_actions row captures actor + reason.
    const adminRow = db
      .prepare(`SELECT * FROM admin_actions WHERE action = 'platform.unfreeze'`)
      .get();
    assert.ok(adminRow, 'admin_actions row must exist');
    assert.equal(adminRow.actor_email, PLATFORM_OWNER_EMAIL);
    const metadata = JSON.parse(adminRow.metadata);
    assert.match(metadata.reason, /incident 42 resolved/);

    // audit_log row captures the same event under dashboard_id = 'system'.
    const auditRow = db
      .prepare(
        `SELECT * FROM audit_log
         WHERE action = 'platform.unfreeze' AND dashboard_id = 'system'`,
      )
      .get();
    assert.ok(auditRow, 'audit_log row must exist');
    assert.equal(auditRow.actor_email, PLATFORM_OWNER_EMAIL);
    const details = JSON.parse(auditRow.details);
    assert.match(details.reason, /incident 42 resolved/);
  });

  it('caps the stored reason at 1000 characters', async () => {
    const { token } = createTestSession({ email: PLATFORM_OWNER_EMAIL });
    const huge = 'x'.repeat(5000);
    const res = await request
      .post('/dashboard/platform/unfreeze')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: huge });
    assert.equal(res.status, 200);

    const adminRow = db
      .prepare(`SELECT * FROM admin_actions WHERE action = 'platform.unfreeze'`)
      .get();
    const metadata = JSON.parse(adminRow.metadata);
    // Must not store the full 5000 — short-string cap is applied.
    assert.ok(metadata.reason.length <= 1000);
  });
});
