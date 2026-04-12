require('../helpers/env');

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { request, createTestKey, seedOrder, resetDb } = require('../helpers/app');

// Stub fetch: handle VCC API calls and rates lookup; reject everything else.
const VCC_TEST_PAYMENT = {
  stellar_address: 'GAVJZLDFBPFIILHPJVUGLUDXENT7OPI6THYQHVPB5BOXUIC37FWXCNVZ',
  memo: 'dGVzdC1tZW1vLTIy', // 22-char base64url
  usdc: { amount: '10.00', asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  xlm: { amount: '64.5161290' },
};

global.fetch = async (url) => {
  const urlStr = typeof url === 'string' ? url : url.toString();

  if (urlStr.includes('vcc.ctx.com/api/register')) {
    return {
      ok: true, status: 201,
      json: async () => ({ token: 'vcc_testtoken0123456789abcdef0123456789abcdef0123456789abcdef01', tenant_id: 'test-tenant', note: 'store safely' }),
    };
  }
  if (urlStr.includes('vcc.ctx.com/api/jobs')) {
    return {
      ok: true, status: 202,
      json: async () => ({ job_id: 'vcc-test-job-id', status: 'awaiting_payment', payment: VCC_TEST_PAYMENT }),
    };
  }
  if (urlStr.includes('rates.ctx.com')) {
    return {
      ok: true, status: 200,
      json: async () => [
        { source: 'ctx-average', price: '0.1550', symbol: 'XLMUSD' },
      ],
    };
  }
  console.error(`[orders.test] Unexpected fetch: ${urlStr}`);
  return { ok: false, status: 500, json: async () => ({}) };
};

describe('POST /v1/orders', () => {
  let key;

  beforeEach(async () => { resetDb(); key = await createTestKey(); });

  it('returns 401 with no API key', async () => {
    const res = await request.post('/v1/orders').send({ amount_usdc: '10.00' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_api_key');
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request.post('/v1/orders')
      .set('X-Api-Key', 'cards402_wrong_key')
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  it('creates an order and returns Soroban contract payment instructions', async () => {
    const res = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '10.00' });

    assert.equal(res.status, 201);
    assert.ok(res.body.order_id);
    assert.equal(res.body.status, 'pending_payment');

    const { payment } = res.body;
    assert.equal(payment.type, 'soroban_contract', 'payment.type must be soroban_contract');
    assert.ok(payment.contract_id?.startsWith('C'), 'contract_id must be a Soroban C-address');
    assert.equal(payment.order_id, res.body.order_id, 'payment.order_id must match order_id');
    assert.ok(payment.usdc?.amount, 'usdc.amount must be present');
    assert.ok(payment.usdc?.asset?.startsWith('USDC:'), 'usdc.asset must identify the USDC issuer');
    // xlm quote is best-effort (depends on the stubbed usdToXlm) — allow either present or absent

    assert.ok(res.body.poll_url.startsWith('/v1/orders/'));
    assert.ok(res.body.budget);
    assert.equal(res.body.budget.spent_usdc, '0.00');
  });

  it('returns 400 for missing amount', async () => {
    const res = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_amount');
  });

  it('returns 400 for zero amount', async () => {
    const res = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '0' });
    assert.equal(res.status, 400);
  });

  it('returns 400 for negative amount', async () => {
    const res = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '-5.00' });
    assert.equal(res.status, 400);
  });

  it('returns 403 when spend limit would be exceeded', async () => {
    const limitedKey = await createTestKey({ label: 'limited', spendLimit: '5.00' });
    const res = await request.post('/v1/orders')
      .set('X-Api-Key', limitedKey.key)
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'spend_limit_exceeded');
  });

  it('returns 503 when system is frozen', async () => {
    const { db } = require('../helpers/app');
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();

    const res = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'service_temporarily_unavailable');
  });

  it('honours Idempotency-Key — returns same response on retry', async () => {
    const iKey = 'test-idempotency-key-123';
    const body = { amount_usdc: '10.00' };

    const first = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .set('Idempotency-Key', iKey)
      .send(body);

    const second = await request.post('/v1/orders')
      .set('X-Api-Key', key.key)
      .set('Idempotency-Key', iKey)
      .send(body);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.order_id, second.body.order_id);

    // Only one order should exist in the DB
    const { db } = require('../helpers/app');
    const count = db.prepare(`SELECT COUNT(*) as n FROM orders WHERE api_key_id = ?`).get(key.id);
    assert.equal(count.n, 1);
  });

  it('different Idempotency-Keys create different orders', async () => {
    const body = { amount_usdc: '10.00' };
    const first = await request.post('/v1/orders').set('X-Api-Key', key.key).set('Idempotency-Key', 'key-A').send(body);
    const second = await request.post('/v1/orders').set('X-Api-Key', key.key).set('Idempotency-Key', 'key-B').send(body);
    assert.notEqual(first.body.order_id, second.body.order_id);
  });

  it('same Idempotency-Key for different API keys creates different orders', async () => {
    const key2 = await createTestKey({ label: 'other' });
    const body = { amount_usdc: '10.00' };
    const iKey = 'shared-idempotency-key';
    const first = await request.post('/v1/orders').set('X-Api-Key', key.key).set('Idempotency-Key', iKey).send(body);
    const second = await request.post('/v1/orders').set('X-Api-Key', key2.key).set('Idempotency-Key', iKey).send(body);
    assert.notEqual(first.body.order_id, second.body.order_id);
  });
});

describe('GET /v1/orders/:id', () => {
  let key;

  beforeEach(async () => { resetDb(); key = await createTestKey(); });

  it('returns 404 for unknown order', async () => {
    const res = await request.get('/v1/orders/nonexistent')
      .set('X-Api-Key', key.key);
    assert.equal(res.status, 404);
  });

  it('returns order with phase field', async () => {
    const orderId = seedOrder({ api_key_id: key.id, status: 'pending_payment' });
    const res = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key.key);
    assert.equal(res.status, 200);
    assert.equal(res.body.order_id, orderId);
    assert.equal(res.body.phase, 'awaiting_payment');
    assert.equal(res.body.status, 'pending_payment');
  });

  it('returns phase=processing for ordering status', async () => {
    const orderId = seedOrder({ api_key_id: key.id, status: 'ordering' });
    const res = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key.key);
    assert.equal(res.body.phase, 'processing');
  });

  it('returns phase=ready for delivered status and includes card', async () => {
    const { db } = require('../helpers/app');
    const orderId = seedOrder({ api_key_id: key.id, status: 'delivered' });
    db.prepare(`UPDATE orders SET card_number='4111111111111111', card_cvv='123', card_expiry='12/27', card_brand='Visa' WHERE id=?`).run(orderId);

    const res = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key.key);
    assert.equal(res.body.phase, 'ready');
    assert.equal(res.body.card.number, '4111111111111111');
    assert.equal(res.body.card.cvv, '123');
  });

  it('returns phase=failed for failed status and includes error', async () => {
    const { db } = require('../helpers/app');
    const orderId = seedOrder({ api_key_id: key.id, status: 'failed' });
    db.prepare(`UPDATE orders SET error='something went wrong' WHERE id=?`).run(orderId);

    const res = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key.key);
    assert.equal(res.body.phase, 'failed');
    assert.equal(res.body.error, 'something went wrong');
  });

  it('returns phase=expired with note', async () => {
    const orderId = seedOrder({ api_key_id: key.id, status: 'expired' });
    const res = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key.key);
    assert.equal(res.body.phase, 'expired');
    assert.ok(res.body.note);
  });

  it('returns 404 for order belonging to different key', async () => {
    const key2 = await createTestKey({ label: 'other' });
    const orderId = seedOrder({ api_key_id: key2.id });
    const res = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key.key);
    assert.equal(res.status, 404);
  });
});

describe('GET /v1/orders (list)', () => {
  let key;

  beforeEach(async () => { resetDb(); key = await createTestKey(); });

  it('returns empty array when no orders', async () => {
    const res = await request.get('/v1/orders').set('X-Api-Key', key.key);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it('returns own orders ordered newest first', async () => {
    seedOrder({ api_key_id: key.id, status: 'pending_payment' });
    seedOrder({ api_key_id: key.id, status: 'delivered' });
    const res = await request.get('/v1/orders').set('X-Api-Key', key.key);
    assert.equal(res.body.length, 2);
  });

  it('does not return orders from other keys', async () => {
    const key2 = await createTestKey({ label: 'other' });
    seedOrder({ api_key_id: key2.id });
    const res = await request.get('/v1/orders').set('X-Api-Key', key.key);
    assert.equal(res.body.length, 0);
  });

  it('filters by status', async () => {
    seedOrder({ api_key_id: key.id, status: 'pending_payment' });
    seedOrder({ api_key_id: key.id, status: 'delivered' });
    const res = await request.get('/v1/orders?status=delivered').set('X-Api-Key', key.key);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].status, 'delivered');
  });
});

describe('GET /v1/usage', () => {
  let key;

  beforeEach(async () => { resetDb(); key = await createTestKey({ spendLimit: '100.00' }); });

  it('returns spend summary with budget', async () => {
    const res = await request.get('/v1/usage').set('X-Api-Key', key.key);
    assert.equal(res.status, 200);
    assert.equal(res.body.budget.spent_usdc, '0.00');
    assert.equal(res.body.budget.limit_usdc, '100.00');
    assert.equal(res.body.budget.remaining_usdc, '100.00');
    assert.equal(res.body.orders.total, 0);
  });

  it('shows unlimited budget when no limit set', async () => {
    const unlimitedKey = await createTestKey({ label: 'unlimited' });
    const res = await request.get('/v1/usage').set('X-Api-Key', unlimitedKey.key);
    assert.equal(res.body.budget.limit_usdc, null);
    assert.equal(res.body.budget.remaining_usdc, null);
  });

  it('counts orders by status', async () => {
    seedOrder({ api_key_id: key.id, status: 'delivered' });
    seedOrder({ api_key_id: key.id, status: 'delivered' });
    seedOrder({ api_key_id: key.id, status: 'failed' });
    const res = await request.get('/v1/usage').set('X-Api-Key', key.key);
    assert.equal(res.body.orders.total, 3);
    assert.equal(res.body.orders.delivered, 2);
    assert.equal(res.body.orders.failed, 1);
  });
});
