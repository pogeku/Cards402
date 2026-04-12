// Integration tests for POST /vcc-callback — the HMAC-signed callback from VCC.
// Covers: auth (missing/invalid/replayed), fulfilled path, failed path, idempotency.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { request, db, createTestKey, resetDb } = require('../helpers/app');

const VCC_CALLBACK_SECRET = process.env.VCC_CALLBACK_SECRET; // set in helpers/env.js

// ── Signing helper ────────────────────────────────────────────────────────────

function sign(body, secret = VCC_CALLBACK_SECRET, timestampOverride = null) {
  const timestamp = timestampOverride ?? Date.now().toString();
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyStr}`).digest('hex');
  return { timestamp, signature: `sha256=${sig}`, bodyStr };
}

function makeHeaders(timestamp, signature) {
  return {
    'Content-Type': 'application/json',
    'X-VCC-Timestamp': timestamp,
    'X-VCC-Signature': signature,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function seedOrder(overrides = {}) {
  const { v4: uuidv4 } = require('uuid');
  const id = overrides.id || uuidv4();
  db.prepare(
    `
    INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, webhook_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    overrides.status ?? 'ordering',
    overrides.amount_usdc ?? '10.00',
    overrides.payment_asset ?? 'usdc_soroban',
    overrides.api_key_id ?? null,
    overrides.webhook_url ?? null,
  );
  return id;
}

// ── Auth tests ────────────────────────────────────────────────────────────────

describe('POST /vcc-callback — auth', () => {
  beforeEach(() => resetDb());

  it('returns 401 when X-VCC-Signature header is missing', async () => {
    const body = JSON.stringify({ order_id: 'x', status: 'fulfilled' });
    const res = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', Date.now().toString())
      .send(body);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_signature');
  });

  it('returns 401 when X-VCC-Timestamp header is missing', async () => {
    const body = JSON.stringify({ order_id: 'x', status: 'fulfilled' });
    const res = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Signature', 'sha256=abc')
      .send(body);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_signature');
  });

  it('returns 401 when timestamp is outside the replay window', async () => {
    // Audit C-5: replay window is now 10 minutes (was 5). Use 15 min to be
    // outside the window regardless of minor skew.
    const staleTs = (Date.now() - 15 * 60 * 1000).toString();
    const payload = { order_id: 'x', status: 'fulfilled' };
    const { signature, bodyStr } = sign(payload, VCC_CALLBACK_SECRET, staleTs);
    const res = await request
      .post('/vcc-callback')
      .set(makeHeaders(staleTs, signature))
      .send(bodyStr);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'timestamp_expired');
  });

  it('returns 401 when HMAC signature is wrong', async () => {
    const payload = { order_id: 'x', status: 'fulfilled' };
    const { timestamp, bodyStr } = sign(payload);
    const res = await request
      .post('/vcc-callback')
      .set(makeHeaders(timestamp, 'sha256=badhash'))
      .send(bodyStr);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_signature');
  });

  it('returns 401 when signed with wrong secret', async () => {
    const payload = { order_id: 'x', status: 'fulfilled' };
    const { timestamp, signature, bodyStr } = sign(payload, 'wrong-secret');
    const res = await request
      .post('/vcc-callback')
      .set(makeHeaders(timestamp, signature))
      .send(bodyStr);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_signature');
  });
});

// ── Validated request helpers ─────────────────────────────────────────────────

async function postCallback(payload) {
  const { timestamp, signature, bodyStr } = sign(payload);
  return request.post('/vcc-callback').set(makeHeaders(timestamp, signature)).send(bodyStr);
}

// ── Field validation ──────────────────────────────────────────────────────────

describe('POST /vcc-callback — field validation', () => {
  beforeEach(() => resetDb());

  it('returns 400 when order_id is missing', async () => {
    const res = await postCallback({ status: 'fulfilled' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_fields');
  });

  it('returns 400 when status is missing', async () => {
    const res = await postCallback({ order_id: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_fields');
  });

  it('returns 400 for unrecognised status value', async () => {
    const id = seedOrder();
    const res = await postCallback({ order_id: id, status: 'unknown_status' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_status');
  });

  it('returns 404 when order does not exist', async () => {
    const res = await postCallback({ order_id: 'nonexistent-id', status: 'fulfilled' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'order_not_found');
  });
});

// ── Fulfilled path ────────────────────────────────────────────────────────────

describe('POST /vcc-callback — fulfilled', () => {
  beforeEach(() => resetDb());

  const card = { number: '4111111111111111', cvv: '123', expiry: '12/27', brand: 'Visa' };

  it('transitions order to delivered and stores card details', async () => {
    const id = seedOrder();
    const res = await postCallback({ order_id: id, status: 'fulfilled', card });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
    assert.equal(order.status, 'delivered');
    assert.equal(order.card_number, card.number);
    assert.equal(order.card_cvv, card.cvv);
    assert.equal(order.card_expiry, card.expiry);
    assert.equal(order.card_brand, card.brand);
  });

  it('increments total_spent_usdc on the api_key', async () => {
    const { id: apiKeyId } = await createTestKey({ label: 'spend-test' });
    const orderId = seedOrder({ api_key_id: apiKeyId, amount_usdc: '10.00' });

    await postCallback({ order_id: orderId, status: 'fulfilled', card });

    const keyRow = db.prepare(`SELECT total_spent_usdc FROM api_keys WHERE id = ?`).get(apiKeyId);
    assert.equal(parseFloat(keyRow.total_spent_usdc), 10.0);
  });

  it('does not crash when api_key_id is null (anonymous order)', async () => {
    const id = seedOrder({ api_key_id: null });
    const res = await postCallback({ order_id: id, status: 'fulfilled', card });
    assert.equal(res.status, 200);
  });

  it('is idempotent — second callback on delivered order returns ok with note', async () => {
    const id = seedOrder({ status: 'delivered' });
    const res = await postCallback({ order_id: id, status: 'fulfilled', card });
    assert.equal(res.status, 200);
    assert.equal(res.body.note, 'already_terminal');
  });
});

// ── Failed path ───────────────────────────────────────────────────────────────

describe('POST /vcc-callback — failed', () => {
  beforeEach(() => resetDb());

  it('transitions order to failed and queues a refund', async () => {
    const id = seedOrder({ status: 'ordering', payment_asset: 'usdc_soroban' });
    // seedOrder doesn't set sender_address; set one so scheduleRefund has
    // somewhere to send the refund to. Without it the order is left in
    // refund_pending for manual action rather than going through the happy
    // refund path.
    db.prepare(`UPDATE orders SET sender_address = ? WHERE id = ?`).run(
      'GSENDER000000000000000000000000000000000000000000000000',
      id,
    );

    const res = await postCallback({ order_id: id, status: 'failed', error: 'ctx_unavailable' });
    assert.equal(res.status, 200);

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
    // The fulfillment error is captured first, then scheduleRefund atomically
    // bumps status to refund_pending and (depending on whether the refund
    // xlm/usdc send resolves in this tick) onward to refunded. Any of the
    // three terminal-fail states is acceptable — the point of the assertion
    // is that cards402 moved the order off 'ordering' and recorded the
    // VCC-supplied error.
    assert.ok(
      ['failed', 'refund_pending', 'refunded'].includes(order.status),
      `expected terminal-fail status, got ${order.status}`,
    );
    assert.equal(order.error, 'ctx_unavailable');
  });

  it('uses "fulfillment_failed" as default error when no error field provided', async () => {
    const id = seedOrder();
    await postCallback({ order_id: id, status: 'failed' });
    const order = db.prepare(`SELECT error FROM orders WHERE id = ?`).get(id);
    assert.equal(order.error, 'fulfillment_failed');
  });

  it('is idempotent — second callback on failed order returns ok with note', async () => {
    const id = seedOrder({ status: 'failed' });
    const res = await postCallback({ order_id: id, status: 'failed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.note, 'already_terminal');
  });

  it('is idempotent — callback on refunded order returns ok with note', async () => {
    const id = seedOrder({ status: 'refunded' });
    const res = await postCallback({ order_id: id, status: 'failed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.note, 'already_terminal');
  });
});
