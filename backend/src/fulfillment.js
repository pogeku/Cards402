// @ts-check
// Refund and webhook delivery for the cards402 backend.
// Card fulfillment (CTX ordering + scraping) is handled by the VCC service.

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { assertSafeUrl } = require('./lib/ssrf');
const { sendUsdc, sendXlm } = require('./payments/xlm-sender');
const { event: bizEvent } = require('./lib/logger');

function isFrozen() {
  return /** @type {any} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get())?.value === '1';
}

// Retry delays: attempt 1 → 30s, attempt 2 → 5m, attempt 3 → 30m
const WEBHOOK_RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000];
const MAX_WEBHOOK_ATTEMPTS = 3;

// Audit A-7: per-origin circuit breaker. If a webhook origin fails
// `CB_THRESHOLD` times inside `CB_WINDOW_MS`, subsequent calls to that
// origin fail fast for `CB_COOLDOWN_MS` instead of eating the 10s fetch
// timeout each time. One slow customer webhook can otherwise serialise
// delivery for every other customer. State is in-memory only — a
// restart effectively "forgives" past failures, which is the right
// default for a small cluster.
const CB_THRESHOLD = 5;
const CB_WINDOW_MS = 60_000;
const CB_COOLDOWN_MS = 5 * 60_000;
const circuitBreakerState = new Map(); // origin -> { failures: [ts], openedUntil: 0 }

function getOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function circuitIsOpen(origin) {
  const s = circuitBreakerState.get(origin);
  if (!s) return false;
  return Date.now() < s.openedUntil;
}

function recordCircuitFailure(origin) {
  if (!origin) return;
  let s = circuitBreakerState.get(origin);
  if (!s) {
    s = { failures: [], openedUntil: 0 };
    circuitBreakerState.set(origin, s);
  }
  const now = Date.now();
  s.failures = s.failures.filter(ts => now - ts < CB_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= CB_THRESHOLD) {
    s.openedUntil = now + CB_COOLDOWN_MS;
    bizEvent('webhook.circuit_opened', {
      origin,
      failures: s.failures.length,
      reopen_at: new Date(s.openedUntil).toISOString(),
    });
    s.failures = [];
  }
}

function recordCircuitSuccess(origin) {
  if (!origin) return;
  const s = circuitBreakerState.get(origin);
  if (s) { s.failures = []; s.openedUntil = 0; }
}

async function fireWebhook(url, payload, webhookSecret, _log) {
  const origin = getOrigin(url);
  if (origin && circuitIsOpen(origin)) {
    throw new Error(`webhook circuit open for ${origin}`);
  }

  // B-6: resolve DNS and validate immediately before the fetch, then pin the
  // resolved IP so DNS cannot be rebound between the check and the connection.
  const resolved = await assertSafeUrl(url);
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };

  if (webhookSecret) {
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', webhookSecret).update(`${ts}.${body}`).digest('hex');
    headers['X-Cards402-Signature'] = `sha256=${sig}`;
    headers['X-Cards402-Timestamp'] = ts;
  }

  // Pin to the resolved IP to close the DNS rebinding window.
  // Replace the hostname in the URL with the validated IP; keep the original
  // hostname in the Host header so the server can route the request correctly.
  let fetchUrl = url;
  if (resolved) {
    const parsed = new URL(url);
    const pinnedHost = resolved.family === 6 ? `[${resolved.address}]` : resolved.address;
    parsed.hostname = pinnedHost;
    fetchUrl = parsed.toString();
    headers['Host'] = new URL(url).host; // original hostname:port
  }

  try {
    const res = await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      recordCircuitFailure(origin);
      throw new Error(`webhook HTTP ${res.status}`);
    }
    recordCircuitSuccess(origin);
  } catch (err) {
    // AbortError / network failures also open the circuit on repeat.
    if (!/circuit open/.test(err.message)) recordCircuitFailure(origin);
    throw err;
  }
}

// Queue a webhook for delivery. On first failure, persists to webhook_queue for retry by jobs.js.
async function enqueueWebhook(url, payload, webhookSecret) {
  try {
    await fireWebhook(url, payload, webhookSecret, null);
  } catch (err) {
    const nextAttempt = new Date(Date.now() + WEBHOOK_RETRY_DELAYS_MS[0]).toISOString();
    db.prepare(`
      INSERT INTO webhook_queue (id, url, payload, secret, attempts, next_attempt, last_error)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(uuidv4(), url, JSON.stringify(payload), webhookSecret || null, nextAttempt, err.message);
  }
}

// Refund the payment for an order. Sends USDC or XLM back to the sender address.
// Called on fulfillment failure (via VCC callback) and on order expiry.
async function scheduleRefund(orderId) {
  // Atomic claim: transitions to refund_pending only once.
  // Prevents double-refunds if called concurrently (admin endpoint + job race).
  const now = new Date().toISOString();
  const claimed = db.prepare(`
    UPDATE orders SET status = 'refund_pending', updated_at = ?
    WHERE id = ? AND status NOT IN ('refund_pending', 'refunded')
  `).run(now, orderId);

  if (claimed.changes === 0) {
    console.log(`[refund] ${orderId}: already refunding or refunded — skipping`);
    return;
  }

  const order = /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));
  if (!order) return;

  if (!order.sender_address) {
    console.log(`[refund] ${orderId}: no sender_address — left as refund_pending for manual action`);
    return;
  }

  const isXlm = order.payment_asset === 'xlm_soroban' || order.payment_asset === 'xlm';

  if (isXlm) {
    const xlmAmount = order.payment_xlm_amount;
    if (!xlmAmount) {
      console.log(`[refund] ${orderId}: no payment_xlm_amount — order remains refund_pending`);
      return;
    }
    try {
      const txHash = await sendXlm({
        destination: order.sender_address,
        amount: xlmAmount,
        memo: `refund:${orderId.slice(0, 18)}`,
      });
      db.prepare(`UPDATE orders SET status = 'refunded', refund_stellar_txid = @txid, updated_at = @now WHERE id = @id`)
        .run({ id: orderId, txid: txHash, now: new Date().toISOString() });
      bizEvent('refund.sent', { order_id: orderId, asset: 'xlm', amount: xlmAmount, txid: txHash });
    } catch (err) {
      console.log(`[refund] ${orderId}: XLM refund failed: ${err.message} — remains refund_pending`);
    }
  } else {
    try {
      const txHash = await sendUsdc({
        destination: order.sender_address,
        amount: order.amount_usdc,
        memo: `refund:${orderId.slice(0, 18)}`,
      });
      db.prepare(`UPDATE orders SET status = 'refunded', refund_stellar_txid = @txid, updated_at = @now WHERE id = @id`)
        .run({ id: orderId, txid: txHash, now: new Date().toISOString() });
      bizEvent('refund.sent', { order_id: orderId, asset: 'usdc', amount: order.amount_usdc, txid: txHash });
    } catch (err) {
      console.log(`[refund] ${orderId}: USDC refund failed: ${err.message} — remains refund_pending`);
    }
  }
}

module.exports = { isFrozen, scheduleRefund, enqueueWebhook, fireWebhook, WEBHOOK_RETRY_DELAYS_MS, MAX_WEBHOOK_ATTEMPTS };
