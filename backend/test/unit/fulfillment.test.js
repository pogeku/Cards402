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

// ── F1: refund-send-failure hash capture (audit 2026-04-15) ──────────────
//
// xlm-sender's submitWithRetry now annotates thrown errors with
// stellarStatus ('unknown' | 'applied_failed' | 'not_landed') and a
// pre-computed txHash. scheduleRefund must persist that forensic data on
// the order row so ops can verify the on-chain outcome instead of losing
// it entirely when the refund is ambiguous. These tests pin the contract.

describe('scheduleRefund — F1 stellarStatus + txHash capture', () => {
  beforeEach(() => {
    resetDb();
    xlmSenderMock.sendUsdc = async () => 'refund_usdc_txhash';
    xlmSenderMock.sendXlm = async () => 'refund_xlm_txhash';
  });

  function makeAnnotatedError(message, stellarStatus, txHash) {
    const err = /** @type {any} */ (new Error(message));
    err.stellarStatus = stellarStatus;
    err.txHash = txHash;
    return err;
  }

  it('USDC refund: unknown network outcome writes txHash but leaves refund_pending', async () => {
    // The critical safety property: a tx that MIGHT have landed during a
    // lost-response window must NOT mark the order refunded (that would
    // let a manual operator retry and double-spend), but MUST record the
    // hash so an operator can verify via Horizon directly.
    const AMBIGUOUS_HASH = 'a'.repeat(64);
    xlmSenderMock.sendUsdc = async () => {
      throw makeAnnotatedError(
        'submit network error and Horizon lookup also failed',
        'unknown',
        AMBIGUOUS_HASH,
      );
    };

    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'usdc_soroban',
      amount_usdc: '10.00',
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending', 'must NOT be refunded — outcome is ambiguous');
    assert.equal(
      order.refund_stellar_txid,
      AMBIGUOUS_HASH,
      'hash must be captured so ops can verify on-chain',
    );
  });

  it('XLM refund: applied_failed (tx landed but failed) writes txHash + stays refund_pending', async () => {
    const FAILED_HASH = 'b'.repeat(64);
    xlmSenderMock.sendXlm = async () => {
      throw makeAnnotatedError(
        'tx applied on-chain but failed (tx_failed)',
        'applied_failed',
        FAILED_HASH,
      );
    };

    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'xlm_soroban',
      payment_xlm_amount: '50.00',
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
    assert.equal(order.refund_stellar_txid, FAILED_HASH);
  });

  it('USDC refund: not_landed (safe retry) still persists hash for audit trail', async () => {
    const NOT_LANDED_HASH = 'c'.repeat(64);
    xlmSenderMock.sendUsdc = async () => {
      throw makeAnnotatedError(
        'submit network error and tx not on ledger — safe to retry',
        'not_landed',
        NOT_LANDED_HASH,
      );
    };

    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'usdc_soroban',
      amount_usdc: '10.00',
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
    // Even on 'not_landed' we still save the hash — operators can use it
    // to confirm the tx really never landed before approving a manual
    // resend from a fresh account state.
    assert.equal(order.refund_stellar_txid, NOT_LANDED_HASH);
  });

  it('legacy error without stellarStatus leaves refund_stellar_txid null', async () => {
    // The pre-audit error shape — just an Error with a message, no
    // stellarStatus or txHash. Behaviour must be backwards-compatible:
    // refund_pending with null txid (no forensic data available).
    xlmSenderMock.sendUsdc = async () => {
      throw new Error('Stellar unavailable'); // no markers
    };

    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'usdc_soroban',
      amount_usdc: '10.00',
    });
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
    assert.equal(order.refund_stellar_txid, null);
  });

  it('preserves a prior refund_stellar_txid if already set (does not overwrite)', async () => {
    // A second refund attempt (e.g. manual ops re-run after fixing the
    // underlying issue) must not clobber the forensic hash from the
    // first attempt. COALESCE in recordRefundSendFailure handles this.
    const FIRST_HASH = 'f'.repeat(64);
    const SECOND_HASH = 's'.repeat(64);

    const id = seedOrder({
      sender_address: 'GREFUND_DEST',
      payment_asset: 'usdc_soroban',
      amount_usdc: '10.00',
    });
    // Pre-seed the column as if a prior attempt had already failed.
    db.prepare(`UPDATE orders SET status = 'failed', refund_stellar_txid = ? WHERE id = ?`).run(
      FIRST_HASH,
      id,
    );

    xlmSenderMock.sendUsdc = async () => {
      throw (() => {
        const err = /** @type {any} */ (new Error('still unknown'));
        err.stellarStatus = 'unknown';
        err.txHash = SECOND_HASH;
        return err;
      })();
    };
    await scheduleRefund(id);

    const order = getOrder(id);
    assert.equal(order.status, 'refund_pending');
    // The original hash must survive.
    assert.equal(order.refund_stellar_txid, FIRST_HASH);
  });
});

// ── F2: enqueueWebhook queue-INSERT fail-loud (audit 2026-04-15) ─────────

describe('enqueueWebhook — F2 queue INSERT fail-loud', () => {
  beforeEach(() => {
    resetDb();
    fetchCalls.length = 0;
    fetchShouldFail = false;
    ssrfMock.assertSafeUrl = async () => {};
  });

  it('swallows the webhook_queue INSERT failure but does not throw to the caller', async () => {
    // Simulate the pathological case: delivery fails (fetch 500) AND
    // the webhook_queue INSERT fails too. Pre-F2 this threw from
    // enqueueWebhook up to the caller, and every production caller
    // wraps in .catch(() => {}) — so the delivery was silently lost.
    // Post-F2 the inner try/catch converts the insert failure into a
    // bizEvent and a return, preserving the order-flow semantics.
    fetchShouldFail = true;

    // Monkey-patch webhook_queue insert to explode. Save the original
    // to restore afterwards so other tests aren't affected.
    const originalPrepare = db.prepare.bind(db);
    let insertAttempted = false;
    // @ts-ignore — overriding bound method for the test duration.
    db.prepare = (sql) => {
      if (typeof sql === 'string' && /INSERT INTO webhook_queue/i.test(sql)) {
        insertAttempted = true;
        return {
          run: () => {
            throw new Error('disk full');
          },
        };
      }
      return originalPrepare(sql);
    };
    try {
      // This MUST NOT throw — pre-F2 it did.
      await enqueueWebhook(
        'https://hooks.example.com/order-failed',
        { order_id: 'abc', status: 'failed' },
        null,
      );
      assert.equal(insertAttempted, true, 'INSERT must have been attempted');
    } finally {
      // @ts-ignore — restore.
      db.prepare = originalPrepare;
    }
  });

  it('persists to webhook_queue normally when INSERT works (regression guard for refactor)', async () => {
    // Make sure the inner try/catch didn't accidentally break the happy
    // failure-and-queue path — that's still the dominant code path.
    fetchShouldFail = true;
    await enqueueWebhook(
      'https://hooks.example.com/delivered',
      { order_id: 'xyz', status: 'delivered', card: { number: '4111', cvv: '123' } },
      'secret-for-retry',
    );
    const row = db
      .prepare(`SELECT * FROM webhook_queue WHERE url = 'https://hooks.example.com/delivered'`)
      .get();
    assert.ok(row, 'queue row must exist');
    assert.equal(row.secret, 'secret-for-retry');
    // Card fields must be redacted in the at-rest payload.
    const payload = JSON.parse(row.payload);
    assert.equal(payload.card.number, null);
    assert.equal(payload.card.cvv, null);
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

  // Regression guard for the 2026-04-14 audit.
  //
  // An earlier version of fireWebhook tried to "pin" the resolved IP
  // by rewriting the URL hostname to the IP and setting a Host header.
  // For HTTPS, this broke TLS cert verification: Node/undici validates
  // the server cert against the URL hostname (now the IP), and most
  // CA-issued certs don't include IP addresses in their SAN list, so
  // every hostname-based HTTPS webhook silently failed cert
  // verification and eventually gave up in the retry queue.
  //
  // The fix: drop the rewriting. The test ensures fetch is still
  // called with the ORIGINAL URL even when assertSafeUrl returns a
  // resolved address (the case that triggered the bug).
  it('calls fetch with the original URL even when SSRF resolution returns an IP', async () => {
    ssrfMock.assertSafeUrl = async () => ({ address: '93.184.216.34', family: 4 });
    await fireWebhook('https://hooks.example.com/events', { order_id: 'pin-regression' }, null);
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].url,
      'https://hooks.example.com/events',
      'URL must be the original hostname URL, not a pinned IP — rewriting the URL breaks TLS cert verification',
    );
    // No Host header override either — the older code set one as part
    // of the rewrite. If that's back, the fix regressed.
    assert.ok(
      !fetchCalls[0].opts.headers.Host,
      'no synthetic Host header should be set — fetch derives it from the URL',
    );
  });

  it('calls fetch with the original URL when SSRF resolution returns an IPv6 address', async () => {
    ssrfMock.assertSafeUrl = async () => ({
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6,
    });
    await fireWebhook('https://hooks.example.com/events', { order_id: 'pin-regression-v6' }, null);
    assert.equal(fetchCalls[0].url, 'https://hooks.example.com/events');
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
