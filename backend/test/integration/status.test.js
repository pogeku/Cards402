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
});
