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
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const { url, method } = req;
    const parsedBody =
      body && req.headers['content-type']?.includes('application/json')
        ? (() => {
            try {
              return JSON.parse(body);
            } catch {
              return body;
            }
          })()
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
          return json(200, {
            job_id: jid,
            ctx_order_id: job.ctx_order_id,
            payment_url: job.payment_url,
            note: 'already_exists',
          });
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
        payment_url:
          'web+stellar:pay?destination=GCTXTEST0000000000000000000000000000000000000000000000000&amount=10&memo=t',
        status: 'invoice_issued',
      };
      fakeVccJobs.set(jobId, job);
      return json(201, {
        job_id: jobId,
        ctx_order_id: job.ctx_order_id,
        payment_url: job.payment_url,
      });
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
      return json(200, {
        id: job.id,
        status: job.status,
        ctx_order_id: job.ctx_order_id,
        payment_url: job.payment_url,
      });
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
    await new Promise((r) => fakeVccServer.close(r));
  }
});

beforeEach(() => {
  resetDb();
  resetFakeVcc();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function signVccCallback(payload, secretOverride = null, nonceOverride = null) {
  // v3 protocol — order_id AND per-job nonce are bound into the signing
  // payload. The audit F1-vcc-callback fix (2026-04-15) made v3 mandatory
  // for any order with a stored callback_nonce, so real vcc — which is
  // given the nonce at invoice time — signs v3 and the tests must
  // mirror that. Callers override the nonce only when simulating the
  // attacker (e.g. "unknown nonce" test cases).
  const timestamp = String(Date.now());
  const body = JSON.stringify(payload);
  const orderId = payload.order_id;
  if (!orderId) throw new Error('signVccCallback: payload.order_id is required');
  const secret = secretOverride || process.env.VCC_CALLBACK_SECRET;
  const nonce = nonceOverride !== null ? nonceOverride : getOrderCallbackNonce(orderId);
  const signPayload = nonce
    ? `${timestamp}.${orderId}.${nonce}.${body}`
    : `${timestamp}.${orderId}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(signPayload).digest('hex');
  return { timestamp, signature: `sha256=${sig}`, body, orderId, nonce };
}

// Read the sealed per-order callback_secret from the orders table and
// open it. Tests that simulate vcc need this to sign callbacks the way
// vcc would after F2.
function getOrderCallbackSecret(orderId) {
  const row = db.prepare(`SELECT callback_secret FROM orders WHERE id = ?`).get(orderId);
  if (!row?.callback_secret) return null;
  const { open } = require('../../src/lib/secret-box');
  return open(row.callback_secret);
}

// Read the per-order callback_nonce. Tests simulating vcc include it in
// the signing payload (v3) and as the X-VCC-Nonce header. Audit
// F1-vcc-callback (2026-04-15) made this mandatory for v3-enrolled orders.
function getOrderCallbackNonce(orderId) {
  const row = db.prepare(`SELECT callback_nonce FROM orders WHERE id = ?`).get(orderId);
  return row?.callback_nonce || null;
}

async function createOrderViaApi(apiKey, amount = '10.00') {
  return request
    .post('/v1/orders')
    .set('X-Api-Key', apiKey)
    .set('Content-Type', 'application/json')
    .send({ amount_usdc: amount, payment_asset: 'usdc' });
}

async function simulateSorobanPayment(
  orderId,
  {
    asset = 'usdc_soroban',
    amountUsdc = '10.00',
    senderAddress = 'GFAKESENDER00000000000000000000000000000000000000000000000',
  } = {},
) {
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
    assert.equal(
      createRes.status,
      201,
      `create returned ${createRes.status}: ${JSON.stringify(createRes.body)}`,
    );
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
    const methods = fakeVccCalls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    assert.ok(
      methods.includes('POST /api/register'),
      `expected register, got: ${methods.join(', ')}`,
    );
    assert.ok(methods.includes('POST /api/jobs/invoice'), `expected invoice call`);
    const paidCall = fakeVccCalls.find(
      (c) => c.method === 'POST' && /\/api\/jobs\/.*\/paid$/.test(c.url),
    );
    assert.ok(paidCall, `expected /paid call, got: ${methods.join(', ')}`);

    // 5. The invoice call should have included the order_id + amount + our
    //    canonical callback URL + a ≥16 char secret. The backend stores
    //    amounts via `String(parseFloat(...))` so '10.00' lands as '10' in
    //    the DB and in the forwarded vcc call — compare numerically.
    const invoiceCall = fakeVccCalls.find(
      (c) => c.method === 'POST' && c.url === '/api/jobs/invoice',
    );
    assert.equal(invoiceCall.body.order_id, orderId);
    assert.equal(parseFloat(invoiceCall.body.amount_usdc), 10);
    assert.match(invoiceCall.body.callback_url, /\/vcc-callback$/);
    assert.ok(invoiceCall.body.callback_secret.length >= 16);

    // 6. vcc scrapes and fires the HMAC-signed callback to cards402.
    // F2: vcc would sign with the per-order callback_secret it received in
    // the invoice request, NOT the global env secret. Read the sealed
    // secret back from the orders row to mirror that behaviour.
    const card = { number: '4111111111111111', cvv: '123', expiry: '12/28', brand: 'Visa' };
    const callbackPayload = { order_id: orderId, status: 'fulfilled', card };
    const orderSecret = getOrderCallbackSecret(orderId);
    const { timestamp, signature, body, nonce } = signVccCallback(callbackPayload, orderSecret);
    const callbackRes = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .set('X-VCC-Order-Id', orderId)
      .set('X-VCC-Nonce', nonce)
      .send(body);
    assert.equal(
      callbackRes.status,
      200,
      `callback returned ${callbackRes.status}: ${JSON.stringify(callbackRes.body)}`,
    );

    // 7. Agent polls and sees the card. The brand is normalised before
    // crossing the agent boundary (audit-style sanitisation): the raw
    // upstream merchant string never leaks into the agent transcript.
    const pollRes = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key);
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.body.phase, 'ready');
    assert.equal(pollRes.body.card.number, card.number);
    assert.equal(pollRes.body.card.cvv, card.cvv);
    assert.equal(pollRes.body.card.expiry, card.expiry);
    // Test fixture sends 'Visa' as the raw brand → normaliser maps to
    // 'USD Visa Card'. The raw upstream value still lives in the orders
    // row for ops/audit, just not on the agent-facing API.
    assert.equal(pollRes.body.card.brand, 'USD Visa Card');
  });
});

// ── Failure path ─────────────────────────────────────────────────────────────

describe('e2e cards402 ↔ vcc: vcc reports failure', () => {
  it('vcc callback with status=failed marks the order failed and queues a refund', async () => {
    const { key } = await createTestKey({ label: 'e2e-failed' });

    const createRes = await createOrderViaApi(key);
    const orderId = createRes.body.order_id;
    await simulateSorobanPayment(orderId);

    // Fake vcc callback with a failure reason. F2: sign with the per-order
    // secret so the verifier accepts it.
    const payload = { order_id: orderId, status: 'failed', error: 'ctx_order_rejected' };
    const orderSecret = getOrderCallbackSecret(orderId);
    const { timestamp, signature, body, nonce } = signVccCallback(payload, orderSecret);
    const cbRes = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .set('X-VCC-Order-Id', orderId)
      .set('X-VCC-Nonce', nonce)
      .send(body);
    assert.equal(cbRes.status, 200);

    // vcc-callback writes status='failed' + error, then schedules a refund.
    // scheduleRefund is synchronous up to the Stellar send, which is stubbed
    // to resolve immediately, so by the time we read the row the order is
    // already 'refunded'. Either of those terminal states is acceptable —
    // what matters is that we captured the failure error and the phase the
    // agent sees is a clear terminal.
    const row = db
      .prepare(`SELECT status, error, refund_stellar_txid FROM orders WHERE id = ?`)
      .get(orderId);
    assert.ok(
      ['failed', 'refund_pending', 'refunded'].includes(row.status),
      `expected terminal-fail status, got ${row.status}`,
    );
    const { publicMessage } = require('../../src/lib/sanitize-error');
    const sanitized = publicMessage('ctx_order_rejected');
    assert.equal(row.error, sanitized);
    if (row.status === 'refunded') {
      assert.equal(row.refund_stellar_txid, 'fake-refund-usdc-txhash');
    }

    // Poll and confirm the phase surface the agent sees. The phase mapping
    // groups refund_pending/failed under 'failed' and refunded under 'refunded'.
    const pollRes = await request.get(`/v1/orders/${orderId}`).set('X-Api-Key', key);
    assert.ok(
      ['failed', 'refunded'].includes(pollRes.body.phase),
      `expected terminal phase, got ${pollRes.body.phase}`,
    );
    assert.equal(pollRes.body.error, sanitized);
  });
});

// ── Idempotency: duplicate Soroban event for the same order ──────────────────

describe('e2e cards402 ↔ vcc: duplicate payment event', () => {
  it('second handlePayment for the same order is a no-op (atomic CAS holds)', async () => {
    const { key } = await createTestKey({ label: 'e2e-dup' });
    const orderId = (await createOrderViaApi(key)).body.order_id;

    await simulateSorobanPayment(orderId);
    const invoiceCallsBefore = fakeVccCalls.filter((c) => c.url === '/api/jobs/invoice').length;

    // Second event for the same order — the atomic UPDATE with
    // `WHERE status = 'pending_payment'` should reject it and we shouldn't
    // see a second POST /api/jobs/invoice on the fake vcc.
    await simulateSorobanPayment(orderId);
    const invoiceCallsAfter = fakeVccCalls.filter((c) => c.url === '/api/jobs/invoice').length;

    assert.equal(invoiceCallsAfter, invoiceCallsBefore, 'duplicate event should not re-call vcc');

    // F7: the duplicate event must leave an unmatched_payments row so ops
    // can refund the double-sent funds. Before F7, duplicates vanished
    // silently and the funds sat in the contract with no durable record.
    const unmatched = db
      .prepare(`SELECT * FROM unmatched_payments WHERE claimed_order_id = ?`)
      .all(orderId);
    assert.equal(unmatched.length, 1, 'duplicate event should be recorded in unmatched_payments');
    assert.match(unmatched[0].reason, /order_status_ordering|duplicate_payment/);
  });
});

// ── F1-jobs (2026-04-15): ambiguous outbound payment parking ─────────────
//
// The critical safety property for the first-pass (payment-handler) code
// path: when payCtxOrder throws with stellarStatus='unknown' or
// 'applied_failed' and a txHash, the order must be parked — hash captured
// to ctx_stellar_txid, status='failed' with a specific
// payment_pending_review error, NO auto-refund. A refund here could
// double-spend treasury if the original tx actually landed.

describe('e2e cards402 ↔ vcc: F1 ambiguous CTX payment parking', () => {
  // Swap payCtxOrder at test time by mutating the cached module object.
  // This relies on payment-handler using the `xlmSender.payCtxOrder`
  // pattern (module-object import) rather than destructuring at load.
  //
  // CRITICAL: we MUST fetch the xlm-sender module from require.cache
  // AFTER the `before` hook has run its cache patching, not at
  // describe-parse time. A describe-scoped `const xlmSenderModule =
  // require(...)` would run at parse time — before the before hook's
  // cache replacement — and return a reference to the REAL xlm-sender
  // module. payment-handler would then hold a reference to the FAKE
  // xlm-sender from the post-before cache, and test-time mutations
  // on the real module would have no effect. Getter+cache-lookup inside
  // the test body guarantees we mutate the same object payment-handler
  // is reading from.
  function getXlmSender() {
    const abs = require.resolve('../../src/payments/xlm-sender');
    return require.cache[abs].exports;
  }

  let originalPayCtxOrder;
  beforeEach(() => {
    const xs = getXlmSender();
    if (!originalPayCtxOrder) originalPayCtxOrder = xs.payCtxOrder;
    xs.payCtxOrder = originalPayCtxOrder;
  });
  // Restore when the describe block finishes so downstream test
  // describes (e.g. payment amount validation) still see the before-
  // hook's fake-success stub instead of inheriting a throw stub from
  // our last test.
  after(() => {
    if (originalPayCtxOrder) getXlmSender().payCtxOrder = originalPayCtxOrder;
  });

  function makeAmbiguousError(stellarStatus, hash) {
    const err = /** @type {any} */ (new Error('submit network error ' + stellarStatus));
    err.stellarStatus = stellarStatus;
    err.txHash = hash;
    return err;
  }

  it('parks the order when payCtxOrder throws stellarStatus=unknown with a txHash', async () => {
    const AMBIGUOUS_HASH = 'a'.repeat(64);
    getXlmSender().payCtxOrder = async () => {
      throw makeAmbiguousError('unknown', AMBIGUOUS_HASH);
    };
    const { key } = await createTestKey({ label: 'e2e-ambiguous-unknown' });
    const orderId = (await createOrderViaApi(key)).body.order_id;

    await simulateSorobanPayment(orderId);

    const row = db
      .prepare(
        `SELECT status, error, ctx_stellar_txid, xlm_sent_at, refund_stellar_txid
         FROM orders WHERE id = ?`,
      )
      .get(orderId);

    assert.equal(row.status, 'failed', 'order must be parked as failed');
    assert.equal(row.ctx_stellar_txid, AMBIGUOUS_HASH, 'hash must be captured on orders row');
    assert.equal(row.xlm_sent_at, null, 'xlm_sent_at must stay null — we are not sure');
    // Critical: NO auto-refund. scheduleRefund is not called on this path,
    // so refund_stellar_txid must be null too.
    assert.equal(row.refund_stellar_txid, null, 'must NOT auto-refund on ambiguous outcome');
    // Public-facing error must reflect "pending review", not "refunded".
    assert.match(row.error, /ambiguous on-chain|operator/i);
    assert.doesNotMatch(row.error, /refunded automatically/i);
  });

  it('parks on stellarStatus=applied_failed (tx landed but failed on chain)', async () => {
    const FAILED_HASH = 'b'.repeat(64);
    getXlmSender().payCtxOrder = async () => {
      throw makeAmbiguousError('applied_failed', FAILED_HASH);
    };
    const { key } = await createTestKey({ label: 'e2e-ambiguous-applied-failed' });
    const orderId = (await createOrderViaApi(key)).body.order_id;

    await simulateSorobanPayment(orderId);

    const row = db
      .prepare(`SELECT status, ctx_stellar_txid, refund_stellar_txid FROM orders WHERE id = ?`)
      .get(orderId);
    assert.equal(row.status, 'failed');
    assert.equal(row.ctx_stellar_txid, FAILED_HASH);
    assert.equal(row.refund_stellar_txid, null, 'NO auto-refund on applied_failed');
  });

  it('non-ambiguous error follows the existing auto-refund path', async () => {
    // Control case: a plain thrown Error (no stellarStatus markers) is
    // NOT an ambiguous outcome, so the existing catch-all should fire
    // and schedule an auto-refund as before. This makes sure the new
    // parking branch is narrowly scoped to real ambiguous cases.
    getXlmSender().payCtxOrder = async () => {
      throw new Error('opaque horizon error with no markers');
    };
    const { key } = await createTestKey({ label: 'e2e-ambiguous-legacy' });
    const orderId = (await createOrderViaApi(key)).body.order_id;
    // Need a sender_address for scheduleRefund to actually send.
    db.prepare(`UPDATE orders SET sender_address = 'GTESTSENDER' WHERE id = ?`).run(orderId);

    await simulateSorobanPayment(orderId);

    const row = db
      .prepare(`SELECT status, ctx_stellar_txid, refund_stellar_txid FROM orders WHERE id = ?`)
      .get(orderId);
    // Legacy path: fails + refund (scheduleRefund may flip to refunded
    // or refund_pending depending on whether the fake sendUsdc resolved).
    assert.ok(
      ['failed', 'refund_pending', 'refunded'].includes(row.status),
      `expected terminal-fail status, got ${row.status}`,
    );
    assert.equal(row.ctx_stellar_txid, null, 'no hash for legacy errors without markers');
  });
});

// ── F2: per-order callback secret ────────────────────────────────────────────

describe('e2e cards402 ↔ vcc: per-order callback secret (audit F2)', () => {
  it('rejects a vcc callback signed with the global env secret once the order has its own', async () => {
    const { key } = await createTestKey({ label: 'e2e-f2' });
    const orderId = (await createOrderViaApi(key)).body.order_id;
    await simulateSorobanPayment(orderId);

    // The order now has a per-order callback_secret stored. A vcc impostor
    // who knows only VCC_CALLBACK_SECRET (the env-wide value) cannot forge
    // a callback for this order — the verifier looks up the per-order
    // secret first and only falls back to env when there isn't one.
    const card = { number: '4111111111111111', cvv: '123', expiry: '12/28', brand: 'Visa' };
    const { timestamp, signature, body, nonce } = signVccCallback(
      { order_id: orderId, status: 'fulfilled', card },
      // No per-order secret override → uses env. Should fail because the
      // order has its own secret stored after handlePayment ran.
    );
    const res = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .set('X-VCC-Order-Id', orderId)
      .set('X-VCC-Nonce', nonce)
      .send(body);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_signature');

    // Sanity: re-signing with the per-order secret succeeds.
    const orderSecret = getOrderCallbackSecret(orderId);
    assert.ok(orderSecret, 'per-order callback_secret should be stored after invoice');
    const ok = signVccCallback({ order_id: orderId, status: 'fulfilled', card }, orderSecret);
    const goodRes = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', ok.timestamp)
      .set('X-VCC-Signature', ok.signature)
      .set('X-VCC-Order-Id', orderId)
      .set('X-VCC-Nonce', ok.nonce)
      .send(ok.body);
    assert.equal(goodRes.status, 200);
  });
});

// ── F0 / F7: payment amount validation + unmatched_payments routing ──────────

describe('e2e cards402 ↔ vcc: payment amount validation (audit F0/F7)', () => {
  it('rejects USDC underpayment and routes it to unmatched_payments', async () => {
    const { key } = await createTestKey({ label: 'e2e-underpay' });
    const orderId = (await createOrderViaApi(key, '100.00')).body.order_id;

    // Exploit: pay $0.01 against a $100 order. Before F0 this would have
    // triggered fulfillment against the $100 face value, draining $99.99
    // of treasury per attack order.
    await simulateSorobanPayment(orderId, { amountUsdc: '0.01' });

    // Order must NOT have moved to ordering. No vcc invoice call should
    // have fired, and the row must still be in pending_payment.
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'pending_payment');
    const invoiceCalls = fakeVccCalls.filter((c) => c.url === '/api/jobs/invoice').length;
    assert.equal(invoiceCalls, 0, 'underpaid event must not trigger vcc invoice creation');

    // And the attack payment must be durably recorded so ops can refund.
    const unmatched = db
      .prepare(`SELECT * FROM unmatched_payments WHERE claimed_order_id = ?`)
      .get(orderId);
    assert.ok(unmatched, 'underpaid event must land in unmatched_payments');
    assert.equal(unmatched.reason, 'underpaid_usdc');
    assert.equal(unmatched.amount_usdc, '0.01');
  });

  it('accepts USDC overpayment and records the excess', async () => {
    const { key } = await createTestKey({ label: 'e2e-overpay' });
    const orderId = (await createOrderViaApi(key, '10.00')).body.order_id;

    // Agent pays $10.50 against a $10 order — maybe a rounding guard on
    // the agent side. Accept the payment, fulfill the order, record the
    // $0.50 excess so refund bookkeeping stays honest.
    await simulateSorobanPayment(orderId, { amountUsdc: '10.50' });

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'ordering');
    // excess_usdc is a decimal string at stroop precision
    assert.equal(parseFloat(order.excess_usdc), 0.5);
  });

  it('rejects pay_xlm when the order never quoted XLM', async () => {
    const { key } = await createTestKey({ label: 'e2e-xlm-not-quoted' });
    const orderId = (await createOrderViaApi(key, '10.00')).body.order_id;
    // Force expected_xlm_amount=null — simulating an order created while
    // the XLM price oracle was down, so the agent was only ever offered
    // the USDC branch.
    db.prepare(`UPDATE orders SET expected_xlm_amount = NULL WHERE id = ?`).run(orderId);

    await handlePayment({
      txid: 'fake-xlm-unknown-quote',
      paymentAsset: 'xlm_soroban',
      amountUsdc: null,
      amountXlm: '80.0000000',
      senderAddress: 'GATTACKER000000000000000000000000000000000000000000000000',
      orderId,
    });

    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
    assert.equal(order.status, 'pending_payment');
    const unmatched = db
      .prepare(`SELECT * FROM unmatched_payments WHERE claimed_order_id = ?`)
      .get(orderId);
    assert.ok(unmatched);
    assert.equal(unmatched.reason, 'xlm_not_quoted');
  });

  it('routes payments for unknown order_ids to unmatched_payments', async () => {
    // No createTestKey, no order at all. The attacker invents an order_id
    // and tries to get cards402 to treat it as fulfillable.
    const fakeOrderId = '00000000-0000-0000-0000-000000000000';
    await simulateSorobanPayment(fakeOrderId, { amountUsdc: '100.00' });

    // No order should have been created, and the payment must be recorded.
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(fakeOrderId);
    assert.equal(order, undefined);
    const unmatched = db
      .prepare(`SELECT * FROM unmatched_payments WHERE claimed_order_id = ?`)
      .get(fakeOrderId);
    assert.ok(unmatched);
    assert.equal(unmatched.reason, 'unknown_order');
    assert.equal(unmatched.amount_usdc, '100.00');
  });
});

// ── Callback before handlePayment finishes (race window) ─────────────────────

describe('e2e cards402 ↔ vcc: terminal callback ignored', () => {
  it('fulfilled callback arriving after order is already delivered returns already_terminal', async () => {
    const { key } = await createTestKey({ label: 'e2e-terminal' });
    const orderId = (await createOrderViaApi(key)).body.order_id;
    await simulateSorobanPayment(orderId);

    const card = { number: '4000000000000002', cvv: '456', expiry: '01/29', brand: 'Visa' };
    const orderSecret = getOrderCallbackSecret(orderId);
    const { timestamp, signature, body, nonce } = signVccCallback(
      {
        order_id: orderId,
        status: 'fulfilled',
        card,
      },
      orderSecret,
    );
    await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', timestamp)
      .set('X-VCC-Signature', signature)
      .set('X-VCC-Order-Id', orderId)
      .set('X-VCC-Nonce', nonce)
      .send(body);

    // Second callback for the same order — should be a no-op.
    const sig2 = signVccCallback({ order_id: orderId, status: 'fulfilled', card }, orderSecret);
    const res2 = await request
      .post('/vcc-callback')
      .set('Content-Type', 'application/json')
      .set('X-VCC-Timestamp', sig2.timestamp)
      .set('X-VCC-Signature', sig2.signature)
      .set('X-VCC-Order-Id', orderId)
      .set('X-VCC-Nonce', sig2.nonce)
      .send(sig2.body);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.note, 'already_terminal');
  });
});
