require('../helpers/env');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  request,
  createTestKey,
  createTestSession,
  seedOrder,
  resetDb,
  db,
} = require('../helpers/app');

// ADMIN header is refreshed after every resetDb() call since resetDb clears sessions.
let ADMIN = {};
function refreshAdmin() {
  const { token } = createTestSession({ email: 'admin@cards402.test', role: 'owner' });
  ADMIN = { Authorization: `Bearer ${token}` };
}
refreshAdmin();

describe('Admin auth', () => {
  it('returns 401 with no token', async () => {
    const res = await request.get('/admin/system');
    assert.equal(res.status, 401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await request.get('/admin/system').set('Authorization', 'Bearer invalid-token');
    assert.equal(res.status, 401);
  });
});

describe('POST /admin/api-keys', () => {
  beforeEach(() => {
    resetDb();
    refreshAdmin();
  });

  it('creates a key and returns it once', async () => {
    const res = await request.post('/admin/api-keys').set(ADMIN).send({ label: 'my-agent' });

    assert.equal(res.status, 201);
    assert.ok(res.body.key.startsWith('cards402_'));
    assert.ok(res.body.webhook_secret.startsWith('whsec_'));
    assert.equal(res.body.label, 'my-agent');
    assert.ok(res.body.warning);
  });

  it('stores a bcrypt hash, not the raw key', async () => {
    const res = await request.post('/admin/api-keys').set(ADMIN).send({ label: 'hash-test' });

    const row = db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(res.body.id);
    assert.ok(row.key_hash !== res.body.key, 'Raw key must not be stored');
    assert.ok(row.key_hash.startsWith('$2'), 'Must be a bcrypt hash');
  });

  it('stores spend_limit_usdc when provided', async () => {
    const res = await request
      .post('/admin/api-keys')
      .set(ADMIN)
      .send({ label: 'limited', spend_limit_usdc: '50.00' });

    const row = db.prepare(`SELECT spend_limit_usdc FROM api_keys WHERE id = ?`).get(res.body.id);
    assert.equal(row.spend_limit_usdc, '50.00');
  });

  it('stores default_webhook_url when provided', async () => {
    const res = await request
      .post('/admin/api-keys')
      .set(ADMIN)
      .send({ label: 'webhook-key', default_webhook_url: 'https://example.com/wh' });

    const row = db
      .prepare(`SELECT default_webhook_url FROM api_keys WHERE id = ?`)
      .get(res.body.id);
    assert.equal(row.default_webhook_url, 'https://example.com/wh');
  });
});

describe('GET /admin/api-keys', () => {
  before(async () => {
    resetDb();
    refreshAdmin();
    await createTestKey({ label: 'key-a' });
    await createTestKey({ label: 'key-b' });
  });

  it('lists all keys without exposing key_hash', async () => {
    const res = await request.get('/admin/api-keys').set(ADMIN);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 2);
    for (const k of res.body) {
      assert.ok(!k.key_hash, 'key_hash must not be exposed');
      assert.ok(k.id);
      assert.ok(k.label);
    }
  });
});

describe('PATCH /admin/api-keys/:id', () => {
  let keyId;
  beforeEach(async () => {
    resetDb();
    refreshAdmin();
    const k = await createTestKey({ label: 'orig' });
    keyId = k.id;
  });

  it('updates label', async () => {
    const res = await request
      .patch(`/admin/api-keys/${keyId}`)
      .set(ADMIN)
      .send({ label: 'updated' });
    assert.equal(res.status, 200);
    const row = db.prepare(`SELECT label FROM api_keys WHERE id = ?`).get(keyId);
    assert.equal(row.label, 'updated');
  });

  it('sets spend_limit_usdc', async () => {
    await request.patch(`/admin/api-keys/${keyId}`).set(ADMIN).send({ spend_limit_usdc: '200.00' });
    const row = db.prepare(`SELECT spend_limit_usdc FROM api_keys WHERE id = ?`).get(keyId);
    assert.equal(row.spend_limit_usdc, '200.00');
  });

  it('clears spend_limit_usdc with null', async () => {
    await request.patch(`/admin/api-keys/${keyId}`).set(ADMIN).send({ spend_limit_usdc: '100.00' });
    await request.patch(`/admin/api-keys/${keyId}`).set(ADMIN).send({ spend_limit_usdc: null });
    const row = db.prepare(`SELECT spend_limit_usdc FROM api_keys WHERE id = ?`).get(keyId);
    assert.equal(row.spend_limit_usdc, null);
  });

  it('disables a key', async () => {
    await request.patch(`/admin/api-keys/${keyId}`).set(ADMIN).send({ enabled: false });
    const row = db.prepare(`SELECT enabled FROM api_keys WHERE id = ?`).get(keyId);
    assert.equal(row.enabled, 0);
  });

  it('returns 400 with nothing to update', async () => {
    const res = await request.patch(`/admin/api-keys/${keyId}`).set(ADMIN).send({});
    assert.equal(res.status, 400);
  });

  it('returns 404 for unknown key id', async () => {
    const res = await request.patch(`/admin/api-keys/nonexistent`).set(ADMIN).send({ label: 'x' });
    assert.equal(res.status, 404);
  });
});

describe('GET /admin/orders', () => {
  let key;
  before(async () => {
    resetDb();
    refreshAdmin();
    key = await createTestKey({ label: 'test' });
  });

  it('lists all orders with api_key_label', async () => {
    seedOrder({ api_key_id: key.id, status: 'delivered' });
    const res = await request.get('/admin/orders').set(ADMIN);
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 1);
    const order = res.body.find((o) => o.api_key_label === 'test');
    assert.ok(order, 'Should have api_key_label');
  });

  it('filters by status', async () => {
    resetDb();
    refreshAdmin();
    seedOrder({ api_key_id: key.id, status: 'delivered' });
    seedOrder({ api_key_id: key.id, status: 'failed' });
    const res = await request.get('/admin/orders?status=delivered').set(ADMIN);
    assert.ok(res.body.every((o) => o.status === 'delivered'));
  });
});

describe('GET /admin/stats', () => {
  before(async () => {
    resetDb();
    refreshAdmin();
    const key = await createTestKey();
    seedOrder({ api_key_id: key.id, status: 'delivered', amount_usdc: '10.00' });
    seedOrder({ api_key_id: key.id, status: 'delivered', amount_usdc: '25.00' });
    seedOrder({ api_key_id: key.id, status: 'failed', amount_usdc: '5.00' });
  });

  it('returns aggregate stats', async () => {
    const res = await request.get('/admin/stats').set(ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.total_orders, 3);
    assert.equal(res.body.delivered, 2);
    assert.equal(res.body.failed, 1);
    assert.ok(res.body.active_keys >= 1);
  });
});

describe('POST /admin/system/unfreeze', () => {
  it('clears frozen state and resets failure count', async () => {
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    db.prepare(`UPDATE system_state SET value = '5' WHERE key = 'consecutive_failures'`).run();

    const res = await request.post('/admin/system/unfreeze').set(ADMIN);
    assert.equal(res.status, 200);

    const frozen = db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get();
    const failures = db
      .prepare(`SELECT value FROM system_state WHERE key = 'consecutive_failures'`)
      .get();
    assert.equal(frozen.value, '0');
    assert.equal(failures.value, '0');
  });

  it('records an admin_actions audit row (audit A-17)', async () => {
    resetDb();
    refreshAdmin();
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();

    const res = await request.post('/admin/system/unfreeze').set(ADMIN);
    assert.equal(res.status, 200);

    const rows = db
      .prepare(
        `
      SELECT actor_email, action, target_type FROM admin_actions
      WHERE action = 'system_unfreeze'
      ORDER BY created_at DESC LIMIT 1
    `,
      )
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_email, 'admin@cards402.test');
    assert.equal(rows[0].target_type, 'system');
  });
});

describe('GET /admin/admin-actions', () => {
  beforeEach(() => {
    resetDb();
    refreshAdmin();
  });

  it('returns the audit log with filters', async () => {
    // Generate one audit row via the unfreeze endpoint
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    await request.post('/admin/system/unfreeze').set(ADMIN);

    const res = await request.get('/admin/admin-actions').set(ADMIN);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const unfreeze = res.body.find((r) => r.action === 'system_unfreeze');
    assert.ok(unfreeze, 'should find the unfreeze row we just emitted');
    assert.equal(unfreeze.target_type, 'system');
    assert.equal(typeof unfreeze.metadata, 'object');
  });

  it('filters by action', async () => {
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    await request.post('/admin/system/unfreeze').set(ADMIN);

    const res = await request.get('/admin/admin-actions?action=system_unfreeze').set(ADMIN);
    assert.equal(res.status, 200);
    assert.ok(res.body.every((r) => r.action === 'system_unfreeze'));
  });
});

describe('POST /admin/orders/:id/refund', () => {
  let key;
  beforeEach(async () => {
    resetDb();
    refreshAdmin();
    key = await createTestKey();
  });

  it('queues a manual refund for a failed order', async () => {
    const orderId = seedOrder({ api_key_id: key.id, status: 'failed' });
    const res = await request.post(`/admin/orders/${orderId}/refund`).set(ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const order = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'refund_pending');
  });

  it('returns 404 for unknown order id', async () => {
    const res = await request.post('/admin/orders/nonexistent/refund').set(ADMIN);
    assert.equal(res.status, 404);
  });

  it('returns 401 with invalid token', async () => {
    const orderId = seedOrder({ api_key_id: key.id, status: 'failed' });
    const res = await request
      .post(`/admin/orders/${orderId}/refund`)
      .set('Authorization', 'Bearer bad-token');
    assert.equal(res.status, 401);
  });
});
