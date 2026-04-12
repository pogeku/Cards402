// Unit tests for vcc-client.js — verifyVccSignature, getInvoice auto-
// registration, and the HMAC-signed callback contract. `dispatchFulfillment`
// was removed in the V2→V3 refactor; getInvoice is the functional replacement.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── Module cache patching ─────────────────────────────────────────────────────

function patchCache(relPath, exports) {
  const abs = require.resolve(`../../src/${relPath}`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

// Patch db before requiring vcc-client
const db = require('../../src/db');
patchCache('db', db);

// Patch logger to silence output
patchCache('lib/logger', { event: () => {} });

const { verifyVccSignature, getInvoice, notifyPaid } = require('../../src/vcc-client');

// ── Fetch mock ────────────────────────────────────────────────────────────────

const fetchCalls = [];
let fetchResponse = null;

global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return fetchResponse;
};

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearVccToken() {
  db.prepare(`DELETE FROM system_state WHERE key = 'vcc_token'`).run();
}

function storeVccToken(token) {
  db.prepare(`INSERT OR REPLACE INTO system_state (key, value) VALUES ('vcc_token', ?)`).run(token);
}

function getStoredToken() {
  return db.prepare(`SELECT value FROM system_state WHERE key = 'vcc_token'`).get()?.value;
}

const VCC_CALLBACK_SECRET = process.env.VCC_CALLBACK_SECRET;

function makeSignature(body, secret = VCC_CALLBACK_SECRET, ts = Date.now().toString()) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { timestamp: ts, signature: `sha256=${sig}` };
}

// ── verifyVccSignature ────────────────────────────────────────────────────────
//
// verifyVccSignature now returns a rich verdict object `{ ok, version, reason }`
// instead of a bare boolean. Legacy v1 callbacks (no order_id in payload) are
// still accepted during the rollout; v2 callbacks bind the order_id into the
// HMAC payload. See backend/src/lib/hmac.js.

function makeV1Signature(body, secret = VCC_CALLBACK_SECRET, ts = Date.now().toString()) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { timestamp: ts, signature: `sha256=${sig}` };
}

function makeV2Signature(body, orderId, secret = VCC_CALLBACK_SECRET, ts = Date.now().toString()) {
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${orderId}.${body}`).digest('hex');
  return { timestamp: ts, signature: `sha256=${sig}` };
}

describe('verifyVccSignature (v2)', () => {
  it('accepts a valid v2 signature with order_id', () => {
    const body = '{"order_id":"abc","status":"fulfilled"}';
    const ts = Date.now().toString();
    const { signature } = makeV2Signature(body, 'abc', VCC_CALLBACK_SECRET, ts);
    const v = verifyVccSignature(body, signature, ts, 'abc');
    assert.equal(v.ok, true);
    assert.equal(v.version, 2);
  });

  it('rejects a v2 signature when order_id is swapped', () => {
    const body = '{"order_id":"abc"}';
    const ts = Date.now().toString();
    const { signature } = makeV2Signature(body, 'abc', VCC_CALLBACK_SECRET, ts);
    const v = verifyVccSignature(body, signature, ts, 'different-order');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('accepts a valid legacy v1 signature when X-VCC-Order-Id is absent', () => {
    const body = '{"order_id":"abc","status":"fulfilled"}';
    const ts = Date.now().toString();
    const { signature } = makeV1Signature(body, VCC_CALLBACK_SECRET, ts);
    const v = verifyVccSignature(body, signature, ts, undefined);
    assert.equal(v.ok, true);
    assert.equal(v.version, 1);
  });

  it('falls back to v1 verification when v2 fails and header is present', () => {
    // If the sender is still on v1 but the client passed a spurious order-id
    // header, v2 verify fails and v1 still succeeds.
    const body = '{"order_id":"abc"}';
    const ts = Date.now().toString();
    const { signature } = makeV1Signature(body, VCC_CALLBACK_SECRET, ts);
    const v = verifyVccSignature(body, signature, ts, 'abc');
    assert.equal(v.ok, true);
    assert.equal(v.version, 1);
  });

  it('returns bad_signature for wrong secret', () => {
    const body = '{"order_id":"abc"}';
    const ts = Date.now().toString();
    const { signature } = makeV2Signature(
      body,
      'abc',
      'wrong-secret-of-sufficient-length-really',
      ts,
    );
    const v = verifyVccSignature(body, signature, ts, 'abc');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('returns bad_signature for tampered body', () => {
    const body = '{"order_id":"abc"}';
    const ts = Date.now().toString();
    const { signature } = makeV2Signature(body, 'abc', VCC_CALLBACK_SECRET, ts);
    const v = verifyVccSignature('{"order_id":"tampered"}', signature, ts, 'abc');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('returns missing_fields when signature is null', () => {
    const v = verifyVccSignature('body', null, Date.now().toString(), 'abc');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_fields');
  });

  it('returns missing_fields when timestamp is null', () => {
    const v = verifyVccSignature('body', 'sha256=abc', null, 'abc');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_fields');
  });

  it('returns bad_signature for short hex signatures (timing-safe path)', () => {
    const body = '{"x":1}';
    const ts = Date.now().toString();
    const v = verifyVccSignature(body, 'sha256=short', ts, 'abc');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('returns timestamp_expired for stale callbacks', () => {
    const body = '{"order_id":"abc"}';
    const ts = String(Date.now() - 20 * 60 * 1000); // 20 min old
    const { signature } = makeV2Signature(body, 'abc', VCC_CALLBACK_SECRET, ts);
    const v = verifyVccSignature(body, signature, ts, 'abc');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'timestamp_expired');
  });
});

// ── Auto-registration (getVccToken behavior observed via getInvoice) ─────────

describe('auto-registration', () => {
  beforeEach(() => {
    clearVccToken();
    fetchCalls.length = 0;
  });

  it('registers with VCC when no token is cached, then fetches the invoice', async () => {
    // First fetch = /api/register, second = /api/jobs/invoice
    let callCount = 0;
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      callCount++;
      if (callCount === 1)
        return makeResponse(201, { tenant_id: 'tid-1', token: 'vcc_freshtoken' });
      return makeResponse(201, {
        job_id: 'job-1',
        payment_url: 'web+stellar:pay?destination=G...&amount=5',
      });
    };

    const { vccJobId, paymentUrl } = await getInvoice('order-reg', '5.00');

    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].url.includes('/api/register'), 'first call should be to /api/register');
    assert.equal(getStoredToken(), 'vcc_freshtoken');
    assert.equal(fetchCalls[1].opts.headers['X-VCC-Token'], 'vcc_freshtoken');
    assert.equal(vccJobId, 'job-1');
    assert.match(paymentUrl, /^web\+stellar:pay/);

    // Restore default fetch mock
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchResponse;
    };
  });

  it('skips registration and uses cached token on second call', async () => {
    storeVccToken('vcc_alreadycached');
    fetchResponse = makeResponse(201, { job_id: 'job-2', payment_url: 'web+stellar:pay?x=1' });
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchResponse;
    };

    await getInvoice('order-cached', '5.00');
    assert.equal(fetchCalls.length, 1, 'should not register again');
    assert.ok(
      !fetchCalls[0].url.includes('/api/register'),
      'only call should be to /api/jobs/invoice',
    );
    assert.ok(fetchCalls[0].url.includes('/api/jobs/invoice'));
  });

  it('throws when registration itself fails', async () => {
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return makeResponse(500, { error: 'server_error' });
    };
    await assert.rejects(() => getInvoice('order-regfail', '5.00'), /VCC registration failed/);
    assert.equal(getStoredToken(), undefined);
    // Restore
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchResponse;
    };
  });
});

// ── getInvoice (was: dispatchFulfillment) ────────────────────────────────────

describe('getInvoice', () => {
  beforeEach(() => {
    clearVccToken();
    storeVccToken('vcc_invoicetoken');
    fetchCalls.length = 0;
    fetchResponse = makeResponse(201, { job_id: 'job-inv', payment_url: 'web+stellar:pay?x=1' });
    // Reinstall standard mock in case auto-registration tests overrode it
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchResponse;
    };
  });

  it('posts to /api/jobs/invoice with the correct body shape', async () => {
    await getInvoice('order-abc', '25.00');
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith('/api/jobs/invoice'));
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.order_id, 'order-abc');
    assert.equal(body.amount_usdc, '25.00');
    assert.ok(
      body.callback_url.includes('/vcc-callback'),
      'callback_url should point to /vcc-callback',
    );
    assert.ok(body.callback_secret, 'callback_secret should be present');
    assert.ok(body.callback_secret.length >= 16, 'callback_secret should be at least 16 chars');
  });

  it('sends X-VCC-Token header with stored token', async () => {
    await getInvoice('order-def', '5.00');
    assert.equal(fetchCalls[0].opts.headers['X-VCC-Token'], 'vcc_invoicetoken');
  });

  it('propagates X-Request-ID when a requestId is provided (audit C-1)', async () => {
    await getInvoice('order-rid', '5.00', 'req_abc123');
    assert.equal(fetchCalls[0].opts.headers['X-Request-ID'], 'req_abc123');
  });

  it('omits X-Request-ID when requestId is null', async () => {
    await getInvoice('order-norid', '5.00', null);
    assert.equal(fetchCalls[0].opts.headers['X-Request-ID'], undefined);
  });

  it('returns { vccJobId, paymentUrl } mapped from vcc response', async () => {
    fetchResponse = makeResponse(201, {
      job_id: 'job-42',
      payment_url: 'web+stellar:pay?mapped=1',
    });
    const result = await getInvoice('order-map', '5.00');
    assert.equal(result.vccJobId, 'job-42');
    assert.equal(result.paymentUrl, 'web+stellar:pay?mapped=1');
  });

  it('clears cached token and throws on 401', async () => {
    fetchResponse = makeResponse(401, { error: 'unauthorized' });
    await assert.rejects(() => getInvoice('order-ghi', '5.00'), /VCC invoice failed.*401/);
    assert.equal(getStoredToken(), undefined);
  });

  it('throws (without clearing token) on other error status', async () => {
    fetchResponse = makeResponse(500, {});
    await assert.rejects(() => getInvoice('order-xyz', '5.00'), /VCC invoice failed.*500/);
    // Token should still be cached
    assert.equal(getStoredToken(), 'vcc_invoicetoken');
  });
});

// ── notifyPaid ───────────────────────────────────────────────────────────────

describe('notifyPaid', () => {
  beforeEach(() => {
    clearVccToken();
    storeVccToken('vcc_paidtoken');
    fetchCalls.length = 0;
    fetchResponse = makeResponse(200, { ok: true });
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return fetchResponse;
    };
  });

  it('POSTs to /api/jobs/:id/paid with the auth header', async () => {
    await notifyPaid('job-abc');
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith('/api/jobs/job-abc/paid'));
    assert.equal(fetchCalls[0].opts.method, 'POST');
    assert.equal(fetchCalls[0].opts.headers['X-VCC-Token'], 'vcc_paidtoken');
  });

  it('clears cached token and throws on 401', async () => {
    fetchResponse = makeResponse(401, {});
    await assert.rejects(() => notifyPaid('job-xyz'), /VCC notifyPaid failed.*401/);
    assert.equal(getStoredToken(), undefined);
  });
});
