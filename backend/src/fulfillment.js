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
  return (
    /** @type {any} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get())
      ?.value === '1'
  );
}

// Redact PAN / CVV / expiry from a webhook payload before it's persisted
// to either webhook_deliveries.request_body (delivery log, readable via
// /dashboard/webhook-deliveries by any dashboard user with webhook:read)
// or webhook_queue.payload (retry queue, readable by anyone with backend
// DB access). The live outbound fetch still gets the unredacted payload;
// only the at-rest copies are stripped.
//
// card.brand is NOT sensitive (it's just "USD Visa Card" after
// normalizeCardBrand) and is preserved so the delivery log still shows
// useful context.
//
// On retry, jobs.js::retryWebhooks detects a redacted-but-delivered
// payload and re-hydrates card fields from the sealed card vault before
// firing, so the queue path still works end-to-end without persisting
// card data at rest.
function redactCardFields(payload) {
  if (!payload || typeof payload !== 'object' || !payload.card) return payload;
  return {
    ...payload,
    card: {
      ...payload.card,
      number: null,
      cvv: null,
      expiry: null,
      // brand kept as-is — the normalizeCardBrand() output is not PII
    },
  };
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
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
  s.failures = s.failures.filter((ts) => now - ts < CB_WINDOW_MS);
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
  if (s) {
    s.failures = [];
    s.openedUntil = 0;
  }
}

async function fireWebhook(url, payload, webhookSecret, _log) {
  const origin = getOrigin(url);
  if (origin && circuitIsOpen(origin)) {
    throw new Error(`webhook circuit open for ${origin}`);
  }

  // SSRF guard: resolve DNS and validate against the private-IP blocklist
  // immediately before the fetch. The resolved {address, family} is
  // returned but intentionally unused — see the block below.
  //
  // Note on DNS rebinding (audit B-6 history). An earlier version of
  // this function tried to "pin" the resolved IP by rewriting the URL
  // hostname to the IP and setting a Host header, so an attacker
  // couldn't flip DNS to a private range in the ~100ms between our
  // validation and fetch. That rewrite broke TLS: Node/undici verifies
  // the server certificate against the URL hostname, not the Host
  // header, and most CA-issued certs don't include IP addresses in
  // their SAN list — so every HTTPS webhook to a hostname URL would
  // silently fail cert verification. Verified empirically 2026-04-14
  // by hitting https://example.com/ with the URL rewritten to its
  // resolved IP: `fetch failed` on cert mismatch.
  //
  // Properly closing the rebinding window requires pinning at the
  // socket level (undici Agent.connect.lookup) while leaving the URL
  // hostname intact for SNI + cert verification. Node's bundled
  // undici is not exposed via require, so that requires adding the
  // userspace undici package — doubling the undici copy in the tree.
  // For now, accept the residual risk: validate-before-fetch is what
  // ~everyone ships, and the narrow window requires a targeted
  // attacker with live DNS control. Private-IP blocklist covers the
  // much larger attack surface.
  await assertSafeUrl(url);
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };

  let signatureHeader = null;
  if (webhookSecret) {
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', webhookSecret).update(`${ts}.${body}`).digest('hex');
    headers['X-Cards402-Signature'] = `sha256=${sig}`;
    headers['X-Cards402-Timestamp'] = ts;
    signatureHeader = headers['X-Cards402-Signature'];
  }

  const startedAt = Date.now();
  const { recordWebhookDelivery } = require('./lib/webhook-log');
  let responseStatus = null;
  let responseBodyText = null;
  let deliveryError = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });
    responseStatus = res.status;
    try {
      // Clone so we don't consume the body if a caller later reads it.
      responseBodyText = (await res.clone().text()).slice(0, 2000);
    } catch {
      /* ignore — not all responses are readable */
    }
    if (!res.ok) {
      recordCircuitFailure(origin);
      deliveryError = `HTTP ${res.status}`;
      throw new Error(`webhook HTTP ${res.status}`);
    }
    recordCircuitSuccess(origin);
  } catch (err) {
    // AbortError / network failures also open the circuit on repeat.
    if (!/circuit open/.test(err.message)) recordCircuitFailure(origin);
    deliveryError = deliveryError || err.message;
    throw err;
  } finally {
    // Persist a card-redacted copy of the payload to the delivery log.
    // The live fetch above sent the real payload to the agent's URL —
    // this log is just for dashboard debugging and must not carry PAN
    // at rest.
    recordWebhookDelivery({
      url,
      method: 'POST',
      requestBody: redactCardFields(payload),
      responseStatus: responseStatus ?? undefined,
      responseBody: responseBodyText ?? undefined,
      latencyMs: Date.now() - startedAt,
      error: deliveryError ?? undefined,
      signature: signatureHeader ?? undefined,
    });
  }
}

// Queue a webhook for delivery. On first failure, persists a CARD-
// REDACTED copy to webhook_queue for retry by jobs.js. The retry
// handler rehydrates card fields from the sealed card vault before
// firing, so the queue table never stores PAN/CVV/expiry at rest.
async function enqueueWebhook(url, payload, webhookSecret) {
  try {
    await fireWebhook(url, payload, webhookSecret, null);
  } catch (err) {
    const nextAttempt = new Date(Date.now() + WEBHOOK_RETRY_DELAYS_MS[0]).toISOString();
    db.prepare(
      `
      INSERT INTO webhook_queue (id, url, payload, secret, attempts, next_attempt, last_error)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `,
    ).run(
      uuidv4(),
      url,
      JSON.stringify(redactCardFields(payload)),
      webhookSecret || null,
      nextAttempt,
      err.message,
    );
  }
}

// Refund the payment for an order. Sends USDC or XLM back to the sender address.
// Called on fulfillment failure (via VCC callback) and on order expiry.
async function scheduleRefund(orderId) {
  // Atomic claim: transitions to refund_pending only once.
  // Prevents double-refunds if called concurrently (admin endpoint + job race).
  const now = new Date().toISOString();
  const claimed = db
    .prepare(
      `
    UPDATE orders SET status = 'refund_pending', updated_at = ?
    WHERE id = ? AND status NOT IN ('refund_pending', 'refunded')
  `,
    )
    .run(now, orderId);

  if (claimed.changes === 0) {
    console.log(`[refund] ${orderId}: already refunding or refunded — skipping`);
    return;
  }

  const order = /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));
  if (!order) return;

  if (!order.sender_address) {
    console.log(
      `[refund] ${orderId}: no sender_address — left as refund_pending for manual action`,
    );
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
      db.prepare(
        `UPDATE orders SET status = 'refunded', refund_stellar_txid = @txid, updated_at = @now WHERE id = @id`,
      ).run({ id: orderId, txid: txHash, now: new Date().toISOString() });
      bizEvent('refund.sent', { order_id: orderId, asset: 'xlm', amount: xlmAmount, txid: txHash });
    } catch (err) {
      console.log(
        `[refund] ${orderId}: XLM refund failed: ${err.message} — remains refund_pending`,
      );
    }
  } else {
    try {
      const txHash = await sendUsdc({
        destination: order.sender_address,
        amount: order.amount_usdc,
        memo: `refund:${orderId.slice(0, 18)}`,
      });
      db.prepare(
        `UPDATE orders SET status = 'refunded', refund_stellar_txid = @txid, updated_at = @now WHERE id = @id`,
      ).run({ id: orderId, txid: txHash, now: new Date().toISOString() });
      bizEvent('refund.sent', {
        order_id: orderId,
        asset: 'usdc',
        amount: order.amount_usdc,
        txid: txHash,
      });
    } catch (err) {
      console.log(
        `[refund] ${orderId}: USDC refund failed: ${err.message} — remains refund_pending`,
      );
    }
  }
}

module.exports = {
  isFrozen,
  scheduleRefund,
  enqueueWebhook,
  fireWebhook,
  redactCardFields,
  WEBHOOK_RETRY_DELAYS_MS,
  MAX_WEBHOOK_ATTEMPTS,
};
