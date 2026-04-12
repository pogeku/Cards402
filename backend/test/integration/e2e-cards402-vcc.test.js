// End-to-end integration test spanning cards402 and vcc.
//
// This is the test the audit flagged as the biggest missing piece: every
// previous test exercises one side of the boundary in isolation, so it's
// possible to drift the contract between the two services without breaking
// any assertion. This test stands up a fake vcc HTTP server, points cards402
// at it via VCC_API_BASE, and walks an order all the way from creation to
// delivery.
//
// Flow per test:
//   1. Agent creates an order via POST /v1/orders  (cards402 HTTP)
//   2. Synthetic Soroban event fires handlePayment directly
//   3. handlePayment hits the fake vcc: POST /api/register, POST /api/jobs/
//      invoice, POST /api/jobs/:id/paid
//   4. Test simulates vcc's HMAC-signed callback → POST /vcc-callback
//   5. Agent poll of GET /v1/orders/:id returns phase: ready + card
//
// Mocks: xlm-sender (payCtxOrder) is stubbed so we don't attempt real
// network payments; the fake vcc is a real HTTP server so we exercise the
// actual fetch + JSON contract with vcc-client.js end-to-end.

require('../helpers/env');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

// ── Fake vcc server ──────────────────────────────────────────────────────────

let fakeVccServer;
let fakeVccPort;
const fakeVccCalls = [];
const fakeVccJobs = new Map();

function resetFakeVcc() {
  fakeVccCalls.length = 0;
  fakeVccJobs.clear();
}

function fakeVccHandler(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const { url, method } = req;
    const parsedBody = body && req.headers['content-type']?.includes('application/json')
      ? (() => { try { return JSON.parse(body); } catch { return body; } })()
      : body;
    fakeVccCalls.push({ method, url, body: parsedBody, headers: { ...req.headers } });

    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (method === 'POST' && url === '/api/register') {
      return json(200, { token: 'fake-vcc-token-abcdef' });
    }

    if (method === 'POST' && url === '/api/jobs/invoice') {
      const { order_id, amount_usdc, callback_url, callback_secret } = parsedBody || {};
      if (!order_id || !amount_usdc || !callback_url || !callback_secret) {
        return json(400, { error: 'missing_fields' });
      }
      // Idempotency — same tenant/order_id returns the same job
      for (const [jid, job] of fakeVccJobs) {
        if (job.order_id === order_id) {
          return json(200, { job_id: jid, ctx_order_id: job.ctx_order_id, payment_url: job.payment_url, note: 'already_exists' });
        }
      }
      const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
      const job = {
        id: jobId,
        order_id,
        amount_usdc,
        callback_url,
        callback_secret,
        ctx_order_id: `ctx_${crypto.randomBytes(4).toString('hex')}`,
        payment_url: 'web+stellar:pay?destination=GCTXTEST0000000000000000000000000000000000000000000000000&amount=10&memo=t',
        status: 'invoice_issued',
      };
      fakeVccJobs.set(jobId, job);
      return json(201, { job_id: jobId, ctx_order_id: job.ctx_order_id, payment_url: job.payment_url });
    }

    const paidMatch = url.match(/^\/api\/jobs\/([^/]+)\/paid$/);
    if (method === 'POST' && paidMatch) {
      const job = fakeVccJobs.get(paidMatch[1]);
      if (!job) return json(404, { error: 'not_found' });
      if (job.status === 'invoice_issued') job.status = 'queued';
      return json(200, { ok: true });
    }

    const getJobMatch = url.match(/^\/api\/jobs\/([^/]+)$/);
    if (method === 'GET' && getJobMatch) {
      const job = fakeVccJobs.get(getJobMatch[1]);
      if (!job) return json(404, { error: 'not_found' });
      return json(200, { id: job.id, status: job.status, ctx_order_id: job.ctx_order_id, payment_url: job.payment_url });
    }

    json(404, { error: 'not_found' });
  });
}

// ── Module-scoped handles (loaded after we set env vars) ─────────────────────

let request;
let db;
let createTestKey;
let resetDb;
let handlePayment;

// ── Lifecycle ────────────────────────────────────────────────────────────────

before(async () => {
  // 1. Start fake vcc HTTP server on a random port.
  fakeVccServer = http.createServer(fakeVccHandler);
  await new Promise((resolve, reject) => {
    fakeVccServer.once('error', reject);
    fakeVccServer.listen(0, '127.0.0.1', resolve);
  });
  fakeVccPort = fakeVccServer.address().port;

  // 2. Point cards402's vcc-client at it BEFORE any app modules load,
  //    since vcc-client.js captures VCC_API_BASE at module top.
  process.env.VCC_API_BASE = `http://127.0.0.1:${fakeVccPort}`;

  // 3. Stub Stellar network calls. payCtxOrder would otherwise hit real
  //    Horizon; sendUsdc/sendXlm are used by refund paths.
  const xlmSenderAbs = require.resolve('../../src/payments/xlm-sender');
  require.cache[xlmSenderAbs] = {
    id: xlmSenderAbs,
    filename: xlmSenderAbs,
    loaded: true,
    exports: {
      payCtxOrder: async () => 'fake-ctx-xlm-txhash',
      sendXlm: async () => 'fake-refund-xlm-txhash',
      sendUsdc: async () => 'fake-refund-usdc-txhash',
    },
    children: [],
    paths: [],
  };

  // 4. Stub the XLM price oracle so POST /v1/orders doesn't try to hit CTX.
  const xlmPriceAbs = require.resolve('../../src/payments/xlm-price');
  require.cache[xlmPriceAbs] = {
    id: xlmPriceAbs,
    filename: xlmPriceAbs,
    loaded: true,
    exports: {
      usdToXlm: async (usd) => (parseFloat(usd) / 0.12).toFixed(7),
      getXlmUsdPrice: async () => 0.12,
    },
    children: [],
    paths: [],
  };

  // 5. Now load the backend and the extracted handler.
  ({ request, db, createTestKey, resetDb } = require('../helpers/app'));
  ({ handlePayment } = require('../../src/payment-handler'));
});

after(async () => {
  if (fakeVccServer) {
    await new Promise(r => fakeVccServer.close(r));
  }
});

beforeEach(() => {
  resetDb();
  resetFakeVcc();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function signVccCallback(payload) {
  const timestamp = String(Date.now());
  const body = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha256', process.env.VCC_CALLBACK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { timestamp, signature: `sha256=${sig}`, body };
}

async function createOrderViaApi(apiKey, amount = '10.00') {
  return request
    .post('/v1/orders')
    .set('X-Api-Key', apiKey)
    .set('Content-Type', 'application/json')
    .send({ amount_usdc: amount, payment_asset: 'usdc' });
}

async function simulateSorobanPayment(orderId, { asset = 'usdc_soroban', amountUsdc = '10.00', senderAddress = 'GFAKESENDER00000000000000000000000000000000000000000000000' } = {}) {
  await handlePayment({
    txid: `fake-stellar-tx-${crypto.randomBytes(8).toString('hex')}`,
    paymentAsset: asset,
    amountUsdc,
    amountXlm: null,
    senderAddress,
    orderId,
  });
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('e2e cards402 ↔ vcc: happy path', () => {
  it('agent creates order → pays contract → vcc delivers card → agent sees phase: ready', async () => {
    const { key } = await createTestKey({ label: 'e2e-happy' });

    // 1. Create the order via the HTTP API exactly like a real agent would.
    const createRes = await createOrderViaApi(key, '10.00');
    assert.equal(createRes.status, 201, `create returned ${createRes.status}: ${JSON.stringify(createRes.body)}`);
    const orderId = createRes.body.order_id;
    assert.equal(createRes.body.status, 'pending_payment');
    assert.equal(createRes.body.payment.type, 'soroban_contract');
    assert.equal(createRes.body.payment.order_id, orderId);

    // 2. Simulate the Soroban watcher seeing the payment event.
    await simulateSorobanPayment(orderId, { amountUsdc: '10.00' });

    // 3. Assert the order is now in 'ordering' with all three vcc
    //    checkpoints populated (vcc_job_id, xlm_sent_at, vcc_notified_at).
    const afterHandler = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(afterHandler.status, 'ordering');
    assert.ok(afterHandler.vcc_job_id, 'vcc_job_id should be set after getInvoice');
    assert.ok(afterHandler.xlm_sent_at, 'xlm_sent_at should be set after payCtxOrder');
    assert.ok(afterHandler.vcc_notified_at, 'vcc_notified_at should be set after notifyPaid');
    assert.ok(afterHandler.stellar_txid, 'stellar_txid should be stored from the event');

    // 4. Assert the fake vcc received exactly the calls we expect.
    const methods = fakeVccCalls.map(c => `${c.method} ${c.url.split('?')[0]}`);
    assert.ok(methods.includes('POST /api/register'), `expected register, got: ${methods.join(', ')}`);
    assert.ok(methods.includes('POST /api/jobs/invoice'), `expected invoice call`);
    const paidCall = fakeVccCalls.find(c => c.method === 'POST' && /\/api\/jobs\/.*\/paid$/.test(c.url));
    assert.ok(paidCall, `expected /paid call, got: ${methods.join(', ')}`);

    // 5. The invoice call should have included the order_id + amount + our
    //    canonical callback URL + a ≥16 char secret. The backend stores
    //    amounts via `String(parseFloat(...))` so '10.00' lands as '10' in
    //    the DB and in the forwarded vcc call — compare numerically.
    const invoiceCall = fakeVccCalls.find(c => c.method === 'POST' && c.url === '/api/jobs/invoice');
    assert.equal(invoiceCall.body.order_id, orderId);
    assert.equal(parseFloat(invoiceCall.body.amount_usdc), 10);
    assert.match(invoiceCall.body.callback_url, /\/vcc-callback$/);
    assert.ok(invoiceCall.body.callback_secret.length >= 16);

    // 6. vcc scrapes and fires the HMAC-signed callback to cards402.
    const card = { number: '4111111111111111', cvv: '123', expiry: '12/28', brand: 'Visa' };
    const callbackPayload = { order_id: orderId, status: 'fulfilled', card };
    const { timestamp, signature, body } = signVccCallback(callbackPayload);
    const callbackRes = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .send(body);
    assert.equal(callbackRes.status, 200, `callback returned ${callbackRes.status}: ${JSON.stringify(callbackRes.body)}`);

    // 7. Agent polls and sees the card.
    const pollRes = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key);
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.body.phase, 'ready');
    assert.equal(pollRes.body.card.number, card.number);
    assert.equal(pollRes.body.card.cvv, card.cvv);
    assert.equal(pollRes.body.card.expiry, card.expiry);
    assert.equal(pollRes.body.card.brand, card.brand);
  });
});

// ── Failure path ─────────────────────────────────────────────────────────────

describe('e2e cards402 ↔ vcc: vcc reports failure', () => {
  it('vcc callback with status=failed marks the order failed and queues a refund', async () => {
    const { key } = await createTestKey({ label: 'e2e-failed' });

    const createRes = await createOrderViaApi(key);
    const orderId = createRes.body.order_id;
    await simulateSorobanPayment(orderId);

    // Fake vcc callback with a failure reason.
    const payload = { order_id: orderId, status: 'failed', error: 'ctx_order_rejected' };
    const { timestamp, signature, body } = signVccCallback(payload);
    const cbRes = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .send(body);
    assert.equal(cbRes.status, 200);

    // vcc-callback writes status='failed' + error, then schedules a refund.
    // scheduleRefund is synchronous up to the Stellar send, which is stubbed
    // to resolve immediately, so by the time we read the row the order is
    // already 'refunded'. Either of those terminal states is acceptable —
    // what matters is that we captured the failure error and the phase the
    // agent sees is a clear terminal.
    const row = db.prepare(`SELECT status, error, refund_stellar_txid FROM orders WHERE id = ?`).get(orderId);
    assert.ok(['failed', 'refund_pending', 'refunded'].includes(row.status),
      `expected terminal-fail status, got ${row.status}`);
    assert.equal(row.error, 'ctx_order_rejected');
    if (row.status === 'refunded') {
      assert.equal(row.refund_stellar_txid, 'fake-refund-usdc-txhash');
    }

    // Poll and confirm the phase surface the agent sees. The phase mapping
    // groups refund_pending/failed under 'failed' and refunded under 'refunded'.
    const pollRes = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key);
    assert.ok(['failed', 'refunded'].includes(pollRes.body.phase),
      `expected terminal phase, got ${pollRes.body.phase}`);
    assert.equal(pollRes.body.error, 'ctx_order_rejected');
  });
});

// ── Idempotency: duplicate Soroban event for the same order ──────────────────

describe('e2e cards402 ↔ vcc: duplicate payment event', () => {
  it('second handlePayment for the same order is a no-op (atomic CAS holds)', async () => {
    const { key } = await createTestKey({ label: 'e2e-dup' });
    const orderId = (await createOrderViaApi(key)).body.order_id;

    await simulateSorobanPayment(orderId);
    const invoiceCallsBefore = fakeVccCalls.filter(c => c.url === '/api/jobs/invoice').length;

    // Second event for the same order — the atomic UPDATE with
    // `WHERE status = 'pending_payment'` should reject it and we shouldn't
    // see a second POST /api/jobs/invoice on the fake vcc.
    await simulateSorobanPayment(orderId);
    const invoiceCallsAfter = fakeVccCalls.filter(c => c.url === '/api/jobs/invoice').length;

    assert.equal(invoiceCallsAfter, invoiceCallsBefore, 'duplicate event should not re-call vcc');
  });
});

// ── Callback before handlePayment finishes (race window) ─────────────────────

describe('e2e cards402 ↔ vcc: terminal callback ignored', () => {
  it('fulfilled callback arriving after order is already delivered returns already_terminal', async () => {
    const { key } = await createTestKey({ label: 'e2e-terminal' });
    const orderId = (await createOrderViaApi(key)).body.order_id;
    await simulateSorobanPayment(orderId);

    const card = { number: '4000000000000002', cvv: '456', expiry: '01/29', brand: 'Visa' };
    const { timestamp, signature, body } = signVccCallback({ order_id: orderId, status: 'fulfilled', card });
    await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .send(body);

    // Second callback for the same order — should be a no-op.
    const sig2 = signVccCallback({ order_id: orderId, status: 'fulfilled', card });
    const res2 = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', sig2.timestamp)
      .set('X-VCC-Signature', sig2.signature)
      .send(sig2.body);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.note, 'already_terminal');
  });
});
