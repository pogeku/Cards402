// Alerts unit tests: CRUD on rules, evaluator branch coverage,
// seeding, and the system-vs-user role split.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb } = require('../helpers/app');
const alerts = require('../../src/lib/alerts');

// Convenience: every system-kind create needs the platform-owner flag.
function createSystem(input) {
  return alerts.createRule({ ...input, isPlatformOwner: true });
}
function createUser(input) {
  return alerts.createRule({ ...input, isPlatformOwner: false });
}

describe('alerts CRUD', () => {
  const dashboardId = 'dash-alerts-1';

  beforeEach(() => {
    resetDb();
  });

  it('creates a system rule when called by the platform owner', () => {
    const rule = createSystem({
      dashboardId,
      name: 'Test rule',
      kind: 'ctx_auth_dead',
      config: {},
    });
    assert.ok(rule);
    assert.equal(rule.name, 'Test rule');
    assert.equal(rule.kind, 'ctx_auth_dead');
    assert.equal(rule.enabled, true);

    // Owner sees the rule
    const ownerList = alerts.listRules(dashboardId, { isPlatformOwner: true });
    assert.equal(ownerList.length, 1);
    // Non-owner does NOT see system rules even on their own dashboard
    const userList = alerts.listRules(dashboardId, { isPlatformOwner: false });
    assert.equal(userList.length, 0);
  });

  it('rejects unknown rule kinds', () => {
    assert.throws(
      () =>
        createUser({
          dashboardId,
          name: 'Invalid',
          kind: 'bogus_kind',
          config: {},
        }),
      /Unknown alert rule kind/,
    );
  });

  it('rejects system kinds when the caller is not the platform owner', () => {
    assert.throws(
      () =>
        createUser({
          dashboardId,
          name: 'Smuggled',
          kind: 'ctx_auth_dead',
          config: {},
        }),
      /platform owner/i,
    );
  });

  it('allows user kinds for any dashboard owner', () => {
    const rule = createUser({
      dashboardId,
      name: 'My failure rate',
      kind: 'failure_rate_high',
      config: { windowMinutes: 30, thresholdPct: 20 },
    });
    assert.ok(rule);
    assert.equal(rule.kind, 'failure_rate_high');
  });

  it('updates a user rule by id', () => {
    const rule = createUser({
      dashboardId,
      name: 'Original',
      kind: 'failure_rate_high',
      config: { windowMinutes: 30, thresholdPct: 20 },
    });
    const updated = alerts.updateRule(dashboardId, rule.id, {
      name: 'Renamed',
      enabled: false,
    });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.enabled, false);
  });

  it('blocks non-owner update of a system rule', () => {
    const rule = createSystem({
      dashboardId,
      name: 'Frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
    });
    assert.throws(
      () => alerts.updateRule(dashboardId, rule.id, { enabled: false }, { isPlatformOwner: false }),
      /platform owner/i,
    );
  });

  it('blocks non-owner delete of a system rule', () => {
    const rule = createSystem({
      dashboardId,
      name: 'Frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
    });
    assert.throws(
      () => alerts.deleteRule(dashboardId, rule.id, { isPlatformOwner: false }),
      /platform owner/i,
    );
  });

  it('persists notify_email and notify_webhook_url', () => {
    const rule = createUser({
      dashboardId,
      name: 'My spend',
      kind: 'spend_over',
      config: { windowMinutes: 60, thresholdUsd: 100 },
      notifyEmail: 'me@example.com',
      notifyWebhookUrl: 'https://example.com/hook',
    });
    assert.equal(rule.notify_email, 'me@example.com');
    assert.equal(rule.notify_webhook_url, 'https://example.com/hook');

    const reread = alerts
      .listRules(dashboardId, { isPlatformOwner: false })
      .find((r) => r.id === rule.id);
    assert.equal(reread.notify_email, 'me@example.com');
    assert.equal(reread.notify_webhook_url, 'https://example.com/hook');
  });

  it('delete returns false for a rule in another dashboard', () => {
    const rule = createSystem({
      dashboardId,
      name: 'Mine',
      kind: 'ctx_auth_dead',
      config: {},
    });
    const ok = alerts.deleteRule('other-dashboard', rule.id, {
      isPlatformOwner: true,
    });
    assert.equal(ok, false);
    // Still exists
    assert.equal(alerts.listRules(dashboardId, { isPlatformOwner: true }).length, 1);
  });

  it('seedDefaultRules seeds USER kinds for a normal user dashboard', () => {
    alerts.seedDefaultRules(dashboardId, { isPlatformOwner: false });
    const rules = alerts.listRules(dashboardId, { isPlatformOwner: true });
    assert.ok(rules.length > 0);
    for (const r of rules) {
      assert.ok(alerts.USER_KINDS.includes(r.kind), `expected user kind, got ${r.kind}`);
    }
  });

  it('seedDefaultRules seeds SYSTEM + USER kinds for the platform owner', () => {
    alerts.seedDefaultRules(dashboardId, { isPlatformOwner: true });
    const rules = alerts.listRules(dashboardId, { isPlatformOwner: true });
    const systemRules = rules.filter((r) => alerts.SYSTEM_KINDS.includes(r.kind));
    const userRules = rules.filter((r) => alerts.USER_KINDS.includes(r.kind));
    assert.ok(systemRules.length >= 2, 'expected at least the two system defaults');
    assert.ok(userRules.length >= 2, 'expected at least the two user defaults');
  });

  it('seedDefaultRules is idempotent', () => {
    alerts.seedDefaultRules(dashboardId, { isPlatformOwner: false });
    const after1 = alerts.listRules(dashboardId, { isPlatformOwner: true }).length;
    alerts.seedDefaultRules(dashboardId, { isPlatformOwner: false });
    const after2 = alerts.listRules(dashboardId, { isPlatformOwner: true }).length;
    assert.equal(after1, after2);
  });
});

describe('alerts evaluator', () => {
  const dashboardId = 'dash-alerts-eval';

  beforeEach(() => {
    resetDb();
  });

  it('circuit_breaker_frozen trips when system_state.frozen = 1', async () => {
    createSystem({
      dashboardId,
      name: 'Frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
    });
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    const firings = await alerts.evaluateRules(dashboardId);
    assert.equal(firings.length, 1);
  });

  it('ctx_auth_dead does NOT trip when tokens exist', async () => {
    createSystem({
      dashboardId,
      name: 'Auth',
      kind: 'ctx_auth_dead',
      config: {},
    });
    db.prepare(
      `INSERT OR REPLACE INTO system_state (key, value) VALUES ('ctx_refresh_token', 'fake')`,
    ).run();
    const firings = await alerts.evaluateRules(dashboardId);
    assert.equal(firings.length, 0);
  });

  it('ctx_auth_dead trips when refresh token is missing', async () => {
    createSystem({
      dashboardId,
      name: 'Auth',
      kind: 'ctx_auth_dead',
      config: {},
    });
    db.prepare(`DELETE FROM system_state WHERE key = 'ctx_refresh_token'`).run();
    const firings = await alerts.evaluateRules(dashboardId);
    assert.equal(firings.length, 1);
  });

  it('disabled rules never fire', async () => {
    const rule = createSystem({
      dashboardId,
      name: 'Off',
      kind: 'ctx_auth_dead',
      config: {},
    });
    alerts.updateRule(dashboardId, rule.id, { enabled: false }, { isPlatformOwner: true });
    db.prepare(`DELETE FROM system_state WHERE key = 'ctx_refresh_token'`).run();
    const firings = await alerts.evaluateRules(dashboardId);
    assert.equal(firings.length, 0);
  });

  it('cooldown prevents re-firing inside the window', async () => {
    createSystem({
      dashboardId,
      name: 'Frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
    });
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    const first = await alerts.evaluateRules(dashboardId);
    assert.equal(first.length, 1);
    const second = await alerts.evaluateRules(dashboardId);
    assert.equal(second.length, 0);
  });

  it('snoozed rules do not fire even when the condition is met', async () => {
    const rule = createSystem({
      dashboardId,
      name: 'Frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
    });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    alerts.updateRule(dashboardId, rule.id, { snoozedUntil: future }, { isPlatformOwner: true });
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    const firings = await alerts.evaluateRules(dashboardId);
    assert.equal(firings.length, 0);
  });

  it('failure_rate_high is scoped to the rule owner — other tenants do not contribute', async () => {
    // Two dashboards, one with a rule, the other with all the failures.
    const tenantA = 'dash-A';
    const tenantB = 'dash-B';

    // Helper to insert a fake user + dashboard + api key + N orders.
    // The dashboards table FK requires both a user row and a matching
    // dashboards row before we can attach api_keys.
    function ensureDashboard(tenantId) {
      const userId = `user-${tenantId}`;
      db.prepare(`INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'owner')`).run(
        userId,
        `${tenantId}@example.com`,
      );
      db.prepare(`INSERT OR IGNORE INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`).run(
        tenantId,
        userId,
        tenantId,
      );
    }
    function seed(tenantId, delivered, failed) {
      ensureDashboard(tenantId);
      const keyId = uuidv4();
      db.prepare(
        `INSERT INTO api_keys (id, dashboard_id, key_hash, label, enabled, created_at)
         VALUES (?, ?, ?, 'k', 1, datetime('now'))`,
      ).run(keyId, tenantId, `hash-${keyId}`);
      const now = new Date().toISOString();
      for (let i = 0; i < delivered; i++) {
        db.prepare(
          `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
           VALUES (?, 'delivered', '10', 'usdc', ?, ?, ?)`,
        ).run(uuidv4(), keyId, now, now);
      }
      for (let i = 0; i < failed; i++) {
        db.prepare(
          `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
           VALUES (?, 'failed', '10', 'usdc', ?, ?, ?)`,
        ).run(uuidv4(), keyId, now, now);
      }
    }

    // Tenant A: 5 delivered, 1 failed → 16% failure rate
    seed(tenantA, 5, 1);
    // Tenant B: 1 delivered, 9 failed → 90% failure rate (irrelevant!)
    seed(tenantB, 1, 9);

    // Tenant A's "failure_rate > 50%" rule must NOT fire even though
    // the global rate (1+9 / 6+10 = 62.5%) is over the threshold.
    createUser({
      dashboardId: tenantA,
      name: 'A failures',
      kind: 'failure_rate_high',
      config: { windowMinutes: 30, thresholdPct: 50 },
    });
    const aFirings = await alerts.evaluateRules(tenantA);
    assert.equal(aFirings.length, 0, 'Tenant A should not fire on global metrics');

    // Tenant B's rule SHOULD fire because tenant B's actual rate is 90%.
    createUser({
      dashboardId: tenantB,
      name: 'B failures',
      kind: 'failure_rate_high',
      config: { windowMinutes: 30, thresholdPct: 50 },
    });
    const bFirings = await alerts.evaluateRules(tenantB);
    assert.equal(bFirings.length, 1, 'Tenant B should fire on its own metrics');
  });

  it('spend_over is scoped per dashboard', async () => {
    const tenantA = 'dash-A2';
    const tenantB = 'dash-B2';
    function ensureDashboard(tenantId) {
      const userId = `user-${tenantId}`;
      db.prepare(`INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'owner')`).run(
        userId,
        `${tenantId}@example.com`,
      );
      db.prepare(`INSERT OR IGNORE INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`).run(
        tenantId,
        userId,
        tenantId,
      );
    }
    function seedDelivered(tenantId, n, amount = '20') {
      ensureDashboard(tenantId);
      const keyId = uuidv4();
      db.prepare(
        `INSERT INTO api_keys (id, dashboard_id, key_hash, label, enabled, created_at)
         VALUES (?, ?, ?, 'k', 1, datetime('now'))`,
      ).run(keyId, tenantId, `hash-${keyId}`);
      const now = new Date().toISOString();
      for (let i = 0; i < n; i++) {
        db.prepare(
          `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
           VALUES (?, 'delivered', ?, 'usdc', ?, ?, ?)`,
        ).run(uuidv4(), amount, keyId, now, now);
      }
    }
    // Tenant A: $10 delivered, well below threshold
    seedDelivered(tenantA, 1, '10');
    // Tenant B: $200 delivered
    seedDelivered(tenantB, 10, '20');

    createUser({
      dashboardId: tenantA,
      name: 'A spend',
      kind: 'spend_over',
      config: { windowMinutes: 60, thresholdUsd: 100 },
    });
    const aFirings = await alerts.evaluateRules(tenantA);
    assert.equal(aFirings.length, 0);

    createUser({
      dashboardId: tenantB,
      name: 'B spend',
      kind: 'spend_over',
      config: { windowMinutes: 60, thresholdUsd: 100 },
    });
    const bFirings = await alerts.evaluateRules(tenantB);
    assert.equal(bFirings.length, 1);
  });
});

describe('alerts visibility', () => {
  const dashboardId = 'dash-visibility';

  beforeEach(() => {
    resetDb();
  });

  it('listFirings hides system-kind firings from non-owners', async () => {
    createSystem({
      dashboardId,
      name: 'Frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
    });
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    await alerts.evaluateRules(dashboardId);

    const ownerView = alerts.listFirings(dashboardId, { isPlatformOwner: true });
    const userView = alerts.listFirings(dashboardId, { isPlatformOwner: false });
    assert.ok(ownerView.length >= 1);
    assert.equal(userView.length, 0);
  });
});
