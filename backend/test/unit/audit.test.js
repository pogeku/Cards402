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
});
