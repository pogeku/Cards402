// Tests for cards402 fulfillment.js — refunds, webhooks, and freeze state.
// Card delivery itself happens in the VCC service; this file covers what
// cards402 still owns: scheduleRefund, fireWebhook, enqueueWebhook, isFrozen.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ── Mock xlm-sender (Stellar calls) ──────────────────────────────────────────

const xlmSenderMock = {
  sendUsdc: async () => 'refund_usdc_txhash',
  sendXlm: async () => 'refund_xlm_txhash',
};

function patchCache(relPath, exports) {
  const abs = require.resolve(`../../src/${relPath}`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

patchCache('payments/xlm-sender', {
  sendUsdc: (...args) => xlmSenderMock.sendUsdc(...args),
  sendXlm: (...args) => xlmSenderMock.sendXlm(...args),
});

// ssrf mock — assertSafeUrl is called by fireWebhook before every fetch.
// Wrap through the mock object so tests can replace ssrfMock.assertSafeUrl
// after module load (fulfillment.js destructures at load time).
const ssrfMock = { assertSafeUrl: async () => {} };
patchCache('lib/ssrf', {
  assertSafeUrl: (...args) => ssrfMock.assertSafeUrl(...args),
});

// ── Load modules after patching ───────────────────────────────────────────────

const db = require('../../src/db');
const { isFrozen, scheduleRefund, fireWebhook, enqueueWebhook } = require('../../src/fulfillment');

// ── Fetch mock ────────────────────────────────────────────────────────────────

const fetchCalls = [];
let fetchShouldFail = false;

global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  if (fetchShouldFail) {
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'Server Error' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => 'OK' };
};

// ── DB helpers ────────────────────────────────────────────────────────────────

function resetDb() {
  db.prepare(`DELETE FROM orders`).run();
  db.prepare(`DELETE FROM api_keys`).run();
  db.prepare(`DELETE FROM webhook_queue`).run();
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'frozen'`).run();
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'consecutive_failures'`).run();
}

function seedOrder(overrides = {}) {
  const id = overrides.id || uuidv4();
  db.prepare(
    `
    INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, sender_address, webhook_url, payment_xlm_amount)
    VALUES (@id, @status, @amount_usdc, @payment_asset, @api_key_id, @sender_address, @webhook_url, @payment_xlm_amount)
  `,
  ).run({
    id,
    status: 'failed',
    amount_usdc: '10.00',
    payment_asset: 'usdc_soroban',
    api_key_id: null,
    sender_address: null,
    webhook_url: null,
    payment_xlm_amount: null,
    ...overrides,
  });
  return id;
}

function getOrder(id) {
  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id);
}

// ── isFrozen ──────────────────────────────────────────────────────────────────

describe('isFrozen', () => {
  beforeEach(() => resetDb());

  it('returns false when system_state frozen=0', () => {
    assert.equal(isFrozen(), false);
  });

  it('returns true when system_state frozen=1', () => {
    db.prepare(`UPDATE system_state SET value = '1' WHERE key = 'frozen'`).run();
    assert.equal(isFrozen(), true);
  });
});

// ── scheduleRefund ────────────────────────────────────────────────────────────

describe('scheduleRefund', () => {
  beforeEach(() => {
    resetDb();
    fetchCalls.length = 0;
    fetchShouldFail = false;
    xlmSenderMock.sendUsdc = async () => 'refund_usdc_txhash';
    xlmSenderMock.sendXlm = async () => 'refund_xlm_txhash';
  });

  it('sends USDC refund and marks order refunded', async () => {
    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'usdc_soroban',
      amount_usdc: '10.00',
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refunded');
    assert.equal(order.refund_stellar_txid, 'refund_usdc_txhash');
  });

  it('sends XLM refund for xlm_soroban orders', async () => {
    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'xlm_soroban',
      payment_xlm_amount: '50.00',
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refunded');
    assert.equal(order.refund_stellar_txid, 'refund_xlm_txhash');
  });

  it('marks refund_pending when no sender_address', async () => {
    const id = seedOrder({ sender_address: null });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
    assert.equal(order.refund_stellar_txid, null);
  });

  it('marks refund_pending when sendUsdc throws', async () => {
    xlmSenderMock.sendUsdc = async () => {
      throw new Error('Stellar unavailable');
    };
    const id = seedOrder({ sender_address: 'GREFUND_DEST', payment_asset: 'usdc_soroban' });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
  });

  it('marks refund_pending for XLM order with no payment_xlm_amount', async () => {
    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'xlm_soroban',
      payment_xlm_amount: null,
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
  });

  it('no-ops when order does not exist', async () => {
    // Should not throw
    await scheduleRefund('nonexistent-id');
  });
});

// ── fireWebhook ───────────────────────────────────────────────────────────────

describe('fireWebhook', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchShouldFail = false;
    ssrfMock.assertSafeUrl = async () => {};
  });

  it('posts JSON payload to the webhook URL', async () => {
    await fireWebhook(
      'https://hooks.example.com/events',
      { order_id: 'abc', status: 'delivered' },
      null,
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://hooks.example.com/events');
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body.order_id, 'abc');
    assert.equal(body.status, 'delivered');
  });

  it('adds HMAC signature headers when webhookSecret is provided', async () => {
    await fireWebhook('https://hooks.example.com/events', { order_id: 'xyz' }, 'mysecret');

    const { opts } = fetchCalls[0];
    assert.ok(
      opts.headers['X-Cards402-Signature']?.startsWith('sha256='),
      'signature header present',
    );
    assert.ok(opts.headers['X-Cards402-Timestamp'], 'timestamp header present');

    // Verify the HMAC is correct
    const ts = opts.headers['X-Cards402-Timestamp'];
    const body = opts.body;
    const expected = crypto.createHmac('sha256', 'mysecret').update(`${ts}.${body}`).digest('hex');
    assert.equal(opts.headers['X-Cards402-Signature'], `sha256=${expected}`);
  });

  it('omits signature headers when no webhookSecret', async () => {
    await fireWebhook('https://hooks.example.com/events', { status: 'ok' }, null);
    const { opts } = fetchCalls[0];
    assert.ok(!opts.headers['X-Cards402-Signature']);
    assert.ok(!opts.headers['X-Cards402-Timestamp']);
  });

  it('throws when webhook returns non-OK status', async () => {
    fetchShouldFail = true;
    await assert.rejects(
      () => fireWebhook('https://hooks.example.com/fail', {}, null),
      /webhook HTTP 500/,
    );
  });

  it('calls assertSafeUrl before fetching', async () => {
    let ssrfChecked = false;
    ssrfMock.assertSafeUrl = async (url) => {
      ssrfChecked = true;
      assert.equal(url, 'https://hooks.example.com/events');
    };
    await fireWebhook('https://hooks.example.com/events', {}, null);
    assert.ok(ssrfChecked, 'assertSafeUrl should have been called');
  });

  it('propagates SSRF error without making the fetch', async () => {
    ssrfMock.assertSafeUrl = async () => {
      throw new Error('Blocked: private IP');
    };
    await assert.rejects(() => fireWebhook('https://192.168.1.1/hook', {}, null), /Blocked/);
    assert.equal(fetchCalls.length, 0, 'fetch should not be called for SSRF-blocked URLs');
  });
});

// ── enqueueWebhook ────────────────────────────────────────────────────────────

describe('enqueueWebhook', () => {
  beforeEach(() => {
    resetDb();
    fetchCalls.length = 0;
    fetchShouldFail = false;
    ssrfMock.assertSafeUrl = async () => {};
  });

  it('delivers immediately on first attempt when fetch succeeds', async () => {
    await enqueueWebhook('https://hooks.example.com/ok', { status: 'delivered' }, 'secret');

    assert.equal(fetchCalls.length, 1);
    const queued = db.prepare(`SELECT COUNT(*) as n FROM webhook_queue`).get();
    assert.equal(queued.n, 0, 'should not queue when delivery succeeds');
  });

  it('persists to webhook_queue when first delivery fails', async () => {
    fetchShouldFail = true;
    await enqueueWebhook('https://hooks.example.com/fail', { status: 'failed' }, null);

    const queued = db.prepare(`SELECT * FROM webhook_queue`).all();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].url, 'https://hooks.example.com/fail');
    assert.equal(queued[0].attempts, 1);
    assert.equal(queued[0].delivered, 0);
    const payload = JSON.parse(queued[0].payload);
    assert.equal(payload.status, 'failed');
  });

  it('stores webhook_secret in queue for later retry', async () => {
    fetchShouldFail = true;
    await enqueueWebhook('https://hooks.example.com/fail', {}, 'retry-secret');

    const queued = db.prepare(`SELECT secret FROM webhook_queue`).get();
    assert.equal(queued.secret, 'retry-secret');
  });

  it('stores null secret when no webhookSecret provided', async () => {
    fetchShouldFail = true;
    await enqueueWebhook('https://hooks.example.com/fail', {}, null);

    const queued = db.prepare(`SELECT secret FROM webhook_queue`).get();
    assert.equal(queued.secret, null);
  });
});
