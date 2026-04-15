require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { request, seedOrder, resetDb, db, createTestKey } = require('../helpers/app');

describe('GET /status', () => {
  beforeEach(() => resetDb());

  it('returns ok=true when system is healthy', async () => {
    const res = await request.get('/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.frozen, false);
    assert.equal(res.body.consecutive_failures, 0);
  });

  it('returns ok=false and frozen=true when system is frozen', async () => {
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    const res = await request.get('/status');
    assert.equal(res.body.ok, false);
    assert.equal(res.body.frozen, true);
  });

  it('reflects consecutive_failures count', async () => {
    db.prepare(`UPDATE system_state SET value = '2' WHERE key = 'consecutive_failures'`).run();
    const res = await request.get('/status');
    assert.equal(res.body.consecutive_failures, 2);
  });

  it('counts pending_payment and in_progress orders', async () => {
    const key = await createTestKey();
    seedOrder({ api_key_id: key.id, status: 'pending_payment' });
    seedOrder({ api_key_id: key.id, status: 'pending_payment' });
    seedOrder({ api_key_id: key.id, status: 'ordering' });
    seedOrder({ api_key_id: key.id, status: 'delivered' }); // should not count

    const res = await request.get('/status');
    assert.equal(res.body.orders.pending_payment, 2);
    assert.equal(res.body.orders.in_progress, 1);
  });

  // ── F1-status: stellar watcher staleness must flip ok=false ──────────────
  //
  // The watcher silently dying used to leave /status reporting ok:true
  // forever — any ops alerting scraping .ok would miss the incident.
  // /status now includes stellar_watcher_stalled in the ok composition
  // with a 120s threshold.

  it('reports stalled and ok=false when stellar_start_ledger_at is older than 120s', async () => {
    // Seed a stale cursor timestamp. Anything > 120s triggers the
    // stalled flag; use 5 minutes for comfortable margin.
    const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger', ?)`,
    ).run('12345');
    db.prepare(
      `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger_at', ?)`,
    ).run(staleAt);

    const res = await request.get('/status');
    assert.equal(res.body.ok, false, 'ok must flip to false when watcher is stalled');
    assert.equal(res.body.stellar_watcher.stalled, true);
    assert.ok(res.body.stellar_watcher.age_seconds >= 120);
    assert.equal(res.body.stellar_watcher.max_age_seconds, 120);

    // Clean up so the next test doesn't inherit the stale state.
    db.prepare(`DELETE FROM system_state WHERE key = 'stellar_start_ledger'`).run();
    db.prepare(`DELETE FROM system_state WHERE key = 'stellar_start_ledger_at'`).run();
  });

  it('reports ok=true when stellar_start_ledger_at is recent', async () => {
    const freshAt = new Date(Date.now() - 5 * 1000).toISOString(); // 5 seconds ago
    db.prepare(
      `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger', ?)`,
    ).run('12345');
    db.prepare(
      `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger_at', ?)`,
    ).run(freshAt);

    const res = await request.get('/status');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stellar_watcher.stalled, false);

    db.prepare(`DELETE FROM system_state WHERE key = 'stellar_start_ledger'`).run();
    db.prepare(`DELETE FROM system_state WHERE key = 'stellar_start_ledger_at'`).run();
  });

  it('treats null stellar_start_ledger_at as unknown (does not flip ok)', async () => {
    // Fresh install / dev / test — no watcher ever saved a cursor.
    // null age_seconds must NOT flip ok to false, otherwise every
    // fresh install and every test would report unhealthy.
    db.prepare(`DELETE FROM system_state WHERE key = 'stellar_start_ledger_at'`).run();

    const res = await request.get('/status');
    assert.equal(res.body.stellar_watcher.age_seconds, null);
    assert.equal(res.body.stellar_watcher.stalled, false);
    assert.equal(res.body.ok, true);
  });
});
