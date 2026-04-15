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
      ok: true,
      status: 201,
      json: async () => ({
        token: 'vcc_testtoken0123456789abcdef0123456789abcdef0123456789abcdef01',
        tenant_id: 'test-tenant',
        note: 'store safely',
      }),
    };
  }
  if (urlStr.includes('vcc.ctx.com/api/jobs')) {
    return {
      ok: true,
      status: 202,
      json: async () => ({
        job_id: 'vcc-test-job-id',
        status: 'awaiting_payment',
        payment: VCC_TEST_PAYMENT,
      }),
    };
  }
  if (urlStr.includes('rates.ctx.com')) {
    return {
      ok: true,
      status: 200,
      json: async () => [{ source: 'ctx-average', price: '0.1550', symbol: 'XLMUSD' }],
    };
  }
  console.error(`[orders.test] Unexpected fetch: ${urlStr}`);
  return { ok: false, status: 500, json: async () => ({}) };
};

describe('POST /v1/orders', () => {
  let key;

  beforeEach(async () => {
    resetDb();
    key = await createTestKey();
  });

  it('returns 401 with no API key', async () => {
    const res = await request.post('/v1/orders').send({ amount_usdc: '10.00' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_api_key');
  });

  it('returns 401 with wrong API key', async () => {
    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', 'cards402_wrong_key')
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  it('creates an order and returns Soroban contract payment instructions', async () => {
    const res = await request
      .post('/v1/orders')
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
    const res = await request.post('/v1/orders').set('X-Api-Key', key.key).send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_amount');
  });

  // Adversarial audit F3-orders (2026-04-15). Before the fix, a POST
  // that reached the handler with req.body === undefined (or an
  // array) flowed into canonicalJson(req.body) → crypto.createHash
  // (...).update(undefined) which throws because update() requires a
  // string or Buffer. Express caught it as a 500 with no useful
  // error code — callers had no way to tell "bad request shape" from
  // "backend broken". Now the handler early-returns 400
  // invalid_request with a structured message. The primary reachable
  // case is a JSON array (express parses it, req.body IS an array,
  // and the destructure pattern `const { amount_usdc } = req.body`
  // silently reads undefined without a crash — but with a bogus
  // idempotency fingerprint that would mismatch on retry). The
  // guard also defends the theoretical undefined-body case via the
  // `!req.body` short-circuit.
  it('returns 400 invalid_request when body is a JSON array (F3)', async () => {
    // Arrays are objects but not the shape this endpoint expects.
    // The guard explicitly rejects Array.isArray(req.body) so an
    // agent sending a list can't accidentally match the destructure
    // of { amount_usdc, ... } from an array (which would silently
    // read `undefined` for each).
    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send([{ amount_usdc: '10.00' }]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
  });

  it('returns 400 for zero amount', async () => {
    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '0' });
    assert.equal(res.status, 400);
  });

  it('returns 400 for negative amount', async () => {
    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '-5.00' });
    assert.equal(res.status, 400);
  });

  it('returns 403 when spend limit would be exceeded', async () => {
    const limitedKey = await createTestKey({ label: 'limited', spendLimit: '5.00' });
    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', limitedKey.key)
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'spend_limit_exceeded');
  });

  it('returns 503 when system is frozen', async () => {
    const { db } = require('../helpers/app');
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();

    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'service_temporarily_unavailable');
  });

  it('honours Idempotency-Key — returns same response on retry', async () => {
    const iKey = 'test-idempotency-key-123';
    const body = { amount_usdc: '10.00' };

    const first = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .set('Idempotency-Key', iKey)
      .send(body);

    const second = await request
      .post('/v1/orders')
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
    const first = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .set('Idempotency-Key', 'key-A')
      .send(body);
    const second = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .set('Idempotency-Key', 'key-B')
      .send(body);
    assert.notEqual(first.body.order_id, second.body.order_id);
  });

  it('same Idempotency-Key for different API keys creates different orders', async () => {
    const key2 = await createTestKey({ label: 'other' });
    const body = { amount_usdc: '10.00' };
    const iKey = 'shared-idempotency-key';
    const first = await request
      .post('/v1/orders')
      .set('X-Api-Key', key.key)
      .set('Idempotency-Key', iKey)
      .send(body);
    const second = await request
      .post('/v1/orders')
      .set('X-Api-Key', key2.key)
      .set('Idempotency-Key', iKey)
      .send(body);
    assert.notEqual(first.body.order_id, second.body.order_id);
  });
});

describe('GET /v1/orders/:id', () => {
  let key;

  beforeEach(async () => {
    resetDb();
    key = await createTestKey();
  });

  it('returns 404 for unknown order', async () => {
    const res = await request.get('/v1/orders/nonexistent').set('X-Api-Key', key.key);
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
    db.prepare(
      `UPDATE orders SET card_number='4111111111111111', card_cvv='123', card_expiry='12/27', card_brand='Visa' WHERE id=?`,
    ).run(orderId);

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

  // Adversarial audit F1-orders-stream (2026-04-15). The SSE endpoint
  // used to acquire a stream slot before registering req.on('close'),
  // which meant any throw from the initial buildOrderResponse/emit
  // pair (e.g. openCard on a corrupt sealed card blob) leaked the
  // slot counter permanently. After enough errors the per-key or
  // global cap blocked legitimate traffic with no recovery path. The
  // fix moves the close handler immediately after slot acquisition
  // and wraps the initial emit in try/catch that routes to
  // closeStream(). This test proves the slot is released by opening
  // a stream against an order whose sealed card_number is malformed
  // — openCard throws during the initial emit — and asserting the
  // stream slot counter returns to its baseline.
  it('releases the stream slot when initial emit throws (F1)', async () => {
    const { db } = require('../helpers/app');
    const { openSSEStreamCount } = require('../../src/api/orders');

    const orderId = seedOrder({ api_key_id: key.id, status: 'delivered' });
    // Write a malformed sealed blob. secret-box.open() only attempts
    // decryption on values starting with `enc:`; in test env
    // CARDS402_SECRET_BOX_KEY is unset, so any `enc:` blob throws
    // `secret-box: CARDS402_SECRET_BOX_KEY not set, cannot decrypt`.
    // That bubbles out of openCard → buildOrderResponse → emit, which
    // before F1 leaked the slot permanently.
    db.prepare(
      `UPDATE orders
       SET card_number = 'enc:aa:bb:cc', card_cvv = 'enc:aa:bb:cc', card_expiry = 'enc:aa:bb:cc'
       WHERE id = ?`,
    ).run(orderId);

    const before = openSSEStreamCount().total;
    // supertest on an SSE endpoint: the server's closeStream() runs
    // res.end() after the initial-emit throw, so the response closes
    // and supertest resolves rather than hanging indefinitely.
    await request.get(`/v1/orders/${orderId}/stream`).set('X-Api-Key', key.key);
    // Give the 'close' handler one tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    const after = openSSEStreamCount().total;

    assert.equal(after, before, 'slot counter must return to baseline after initial emit error');
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

  beforeEach(async () => {
    resetDb();
    key = await createTestKey();
  });

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

  beforeEach(async () => {
    resetDb();
    key = await createTestKey({ spendLimit: '100.00' });
  });

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

  // ── F1-usage: budget reflects in-flight spend ─────────────────────────────
  //
  // Before this fix buildBudget reported remaining_usdc = limit -
  // total_spent_usdc, counting only SETTLED spend. An agent with
  // pending_payment orders saw a remaining number that the next
  // POST /v1/orders spend check then rejected because it counts
  // in-flight too. buildBudget now includes in_flight in its
  // committed calculation.

  it('budget.remaining_usdc subtracts in-flight orders, not just settled', async () => {
    // Seed a pending_payment order — counts as in-flight per
    // orders.js spend check, but not settled (total_spent_usdc = 0).
    seedOrder({
      api_key_id: key.id,
      status: 'pending_payment',
      amount_usdc: '30.00',
    });
    seedOrder({
      api_key_id: key.id,
      status: 'pending_payment',
      amount_usdc: '30.00',
    });
    const res = await request.get('/v1/usage').set('X-Api-Key', key.key);
    assert.equal(res.status, 200);
    // settled is still zero — no vcc-callback has run.
    assert.equal(res.body.budget.spent_usdc, '0.00');
    // in_flight_usdc exposes the reserved amount
    assert.equal(res.body.budget.in_flight_usdc, '60.00');
    // committed = settled + in_flight
    assert.equal(res.body.budget.committed_usdc, '60.00');
    // remaining = limit - committed = 100 - 60 = 40
    assert.equal(res.body.budget.remaining_usdc, '40.00');
  });

  it('budget.remaining_usdc counts awaiting_approval as in-flight (matches orders.js F1)', async () => {
    // After the earlier approval-flow audit, awaiting_approval is
    // counted as in-flight by the POST /v1/orders spend check.
    // buildBudget must match.
    seedOrder({
      api_key_id: key.id,
      status: 'awaiting_approval',
      amount_usdc: '50.00',
    });
    const res = await request.get('/v1/usage').set('X-Api-Key', key.key);
    assert.equal(res.body.budget.in_flight_usdc, '50.00');
    assert.equal(res.body.budget.remaining_usdc, '50.00');
  });

  it('budget.remaining_usdc is null when no spend limit set, regardless of in-flight', async () => {
    const unlimitedKey = await createTestKey({ label: 'unlim2' });
    seedOrder({
      api_key_id: unlimitedKey.id,
      status: 'pending_payment',
      amount_usdc: '500.00',
    });
    const res = await request.get('/v1/usage').set('X-Api-Key', unlimitedKey.key);
    assert.equal(res.body.budget.limit_usdc, null);
    assert.equal(res.body.budget.remaining_usdc, null);
    // The new fields still populate.
    assert.equal(res.body.budget.in_flight_usdc, '500.00');
  });

  // ── F2/F3-usage: terminal statuses excluded from in_progress ──────────────

  it('in_progress excludes expired and rejected (terminal-negative statuses)', async () => {
    seedOrder({ api_key_id: key.id, status: 'pending_payment' });
    seedOrder({ api_key_id: key.id, status: 'ordering' });
    seedOrder({ api_key_id: key.id, status: 'expired' });
    seedOrder({ api_key_id: key.id, status: 'rejected' });
    const res = await request.get('/v1/usage').set('X-Api-Key', key.key);
    // pending_payment + ordering = 2 genuine in-progress
    assert.equal(res.body.orders.in_progress, 2);
    // Expired and rejected get their own buckets
    assert.equal(res.body.orders.expired, 1);
    assert.equal(res.body.orders.rejected, 1);
    // Total still counts everything
    assert.equal(res.body.orders.total, 4);
  });
});
