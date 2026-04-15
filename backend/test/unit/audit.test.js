// Audit log unit tests. Verifies that recordAudit persists events with
// the right shape and that listAudit filters + paginates correctly.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, resetDb } = require('../helpers/app');
const { recordAudit, listAudit } = require('../../src/lib/audit');

describe('audit log', () => {
  const dashboardId = 'test-dashboard-1';

  beforeEach(() => {
    resetDb();
  });

  it('recordAudit persists a row with normalised role', () => {
    recordAudit({
      dashboardId,
      actor: { id: 'u1', email: 'ash@example.com', role: 'user' }, // legacy value
      action: 'agent.create',
      resourceType: 'agent',
      resourceId: 'agent-123',
      details: { label: 'test' },
      ip: '127.0.0.1',
      userAgent: 'jest',
    });
    const row = db
      .prepare(
        `SELECT actor_email, actor_role, action, resource_type, resource_id, details
         FROM audit_log WHERE dashboard_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(dashboardId);
    assert.equal(row.actor_email, 'ash@example.com');
    // 'user' normalises to 'owner'
    assert.equal(row.actor_role, 'owner');
    assert.equal(row.action, 'agent.create');
    assert.equal(row.resource_type, 'agent');
    assert.equal(row.resource_id, 'agent-123');
    assert.deepEqual(JSON.parse(row.details), { label: 'test' });
  });

  it('listAudit returns most-recent first', () => {
    for (let i = 0; i < 3; i++) {
      recordAudit({
        dashboardId,
        actor: { email: `u${i}@example.com`, role: 'owner' },
        action: 'agent.update',
      });
    }
    const entries = listAudit(dashboardId);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].actor_email, 'u2@example.com');
    assert.equal(entries[2].actor_email, 'u0@example.com');
  });

  it('listAudit filters by action', () => {
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'agent.create',
    });
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'agent.delete',
    });
    const createEntries = listAudit(dashboardId, { action: 'agent.create' });
    assert.equal(createEntries.length, 1);
    assert.equal(createEntries[0].action, 'agent.create');
  });

  it('listAudit filters by actor email', () => {
    recordAudit({
      dashboardId,
      actor: { email: 'alice@example.com', role: 'owner' },
      action: 'agent.update',
    });
    recordAudit({
      dashboardId,
      actor: { email: 'bob@example.com', role: 'owner' },
      action: 'agent.update',
    });
    const aliceEntries = listAudit(dashboardId, { actor: 'alice@example.com' });
    assert.equal(aliceEntries.length, 1);
    assert.equal(aliceEntries[0].actor_email, 'alice@example.com');
  });

  it('listAudit respects limit + offset for pagination', () => {
    for (let i = 0; i < 10; i++) {
      recordAudit({
        dashboardId,
        actor: { email: `u${i}@example.com`, role: 'owner' },
        action: 'agent.update',
      });
    }
    const page1 = listAudit(dashboardId, { limit: 3, offset: 0 });
    const page2 = listAudit(dashboardId, { limit: 3, offset: 3 });
    assert.equal(page1.length, 3);
    assert.equal(page2.length, 3);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('listAudit clamps limit to a sane maximum', () => {
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'agent.update',
    });
    // Request a silly limit — should be clamped to 500 without throwing.
    const entries = listAudit(dashboardId, { limit: 9999 });
    assert.ok(entries.length <= 500);
  });

  it('records "system" actor when actor is null', () => {
    recordAudit({
      dashboardId,
      actor: null,
      action: 'system.cleanup',
    });
    const row = db
      .prepare(`SELECT actor_email, actor_role FROM audit_log WHERE action = ?`)
      .get('system.cleanup');
    assert.equal(row.actor_email, 'system');
    assert.equal(row.actor_role, 'viewer'); // unknown role → viewer
  });

  it('events for dashboard A are not visible to dashboard B', () => {
    recordAudit({
      dashboardId: 'dash-a',
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'agent.create',
    });
    const bEntries = listAudit('dash-b');
    assert.equal(bEntries.length, 0);
  });

  // ── F1 regression: missing required field ────────────────────────────────
  //
  // Previously a caller passing `dashboardId: undefined` (or `action:
  // undefined`) would trip the NOT NULL constraint at insert time; the
  // try/catch swallowed the error and the audit row was silently lost.
  // The whole point of audit logging is that rows always exist — this
  // guard rejects the event at validation time with a loud console.error
  // so ops monitoring sees the caller bug.

  it('DROPS and logs an event with missing dashboardId (does not throw)', () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      recordAudit({
        // @ts-expect-error — intentional missing field
        dashboardId: undefined,
        actor: { email: 'a@example.com', role: 'owner' },
        action: 'agent.create',
      });
    } finally {
      console.error = origError;
    }
    assert.ok(
      errors.some((e) => /DROPPED event with missing required field/.test(e)),
      `expected DROPPED log, got ${JSON.stringify(errors)}`,
    );
    // No row was inserted.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get();
    assert.equal(count.n, 0);
  });

  it('DROPS and logs an event with missing action', () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      recordAudit({
        dashboardId,
        actor: { email: 'a@example.com', role: 'owner' },
        // @ts-expect-error — intentional missing field
        action: undefined,
      });
    } finally {
      console.error = origError;
    }
    assert.ok(errors.some((e) => /DROPPED event with missing required field/.test(e)));
  });

  // ── F2 regression: details size cap ──────────────────────────────────────

  it('truncates an oversized details blob with a marker, still writes the row', () => {
    const huge = 'x'.repeat(100_000);
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'huge.details',
      details: { blob: huge },
    });
    const row = db.prepare(`SELECT details FROM audit_log WHERE action = ?`).get('huge.details');
    const parsed = JSON.parse(row.details);
    assert.equal(parsed._truncated, true);
    assert.ok(parsed._original_bytes > 100_000);
    assert.ok(parsed.preview.length > 0);
    assert.ok(parsed.preview.length <= 512);
  });

  it('preserves a small details blob as-is', () => {
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'small.details',
      details: { label: 'test', nested: { x: 1 } },
    });
    const row = db.prepare(`SELECT details FROM audit_log WHERE action = ?`).get('small.details');
    assert.deepEqual(JSON.parse(row.details), { label: 'test', nested: { x: 1 } });
  });

  it('survives a circular-reference details object with a serialise-failed marker', () => {
    /** @type {any} */
    const circular = { a: 1 };
    circular.self = circular;
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'circular.details',
      details: circular,
    });
    const row = db
      .prepare(`SELECT details FROM audit_log WHERE action = ?`)
      .get('circular.details');
    const parsed = JSON.parse(row.details);
    assert.equal(parsed._serialise_failed, true);
    assert.ok(typeof parsed.error === 'string');
  });

  // ── F3/F4 regression: listAudit input bounds ─────────────────────────────

  it('caps listAudit offset at the configured MAX_LIST_OFFSET', () => {
    // Seed a single row so the test verifies the query runs (no crash).
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'bound.test',
    });
    // offset=1e9 would have previously been passed through; the cap
    // clamps it to MAX_LIST_OFFSET (10_000) so SQLite still executes
    // the query, just with a sane offset that returns 0 rows.
    const result = listAudit(dashboardId, { offset: 1e9 });
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('treats NaN limit/offset as the defaults (no SQLite crash)', () => {
    recordAudit({
      dashboardId,
      actor: { email: 'a@example.com', role: 'owner' },
      action: 'nan.test',
    });
    // Previously `parseInt('abc', 10)` → NaN → `Math.max(1, NaN)` →
    // NaN → `LIMIT NaN` in SQL → better-sqlite3 500.
    const result = listAudit(dashboardId, { limit: NaN, offset: NaN });
    assert.ok(Array.isArray(result));
    assert.ok(result.length >= 1);
  });
});
