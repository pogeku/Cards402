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

/**
 * @param {string} url
 * @param {unknown} payload
 * @param {string|null} webhookSecret
 * @param {unknown} _log — legacy parameter, ignored
 * @param {{ dashboardId?: string | null, apiKeyId?: string | null }} [context]
 *   Optional explicit logging context. Callers that don't have an
 *   order_id in their payload (e.g., POST /dashboard/webhook-deliveries/test
 *   uses a synthetic order_id that won't resolve against the orders
 *   table) pass dashboardId explicitly so recordWebhookDelivery
 *   doesn't silently drop the log entry via its "unattributed
 *   deliveries don't get logged" branch. Adversarial audit F1-webhook-log.
 */
async function fireWebhook(url, payload, webhookSecret, _log, context = {}) {
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
      // Refuse to follow redirects. assertSafeUrl() validates the
      // ORIGINAL hostname against the private-IP blocklist, but
      // Node's fetch follows 3xx responses by default — so a
      // tenant-controlled public HTTPS endpoint could return a
      // 307 to http://127.0.0.1:4000/... or the cloud metadata
      // endpoint and we'd happily follow. 'error' aborts the
      // fetch on any 3xx response, closing the redirect SSRF hole.
      redirect: 'error',
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
      dashboardId: context.dashboardId ?? undefined,
      apiKeyId: context.apiKeyId ?? undefined,
    });
  }
}

// Queue a webhook for delivery. On first failure, persists a CARD-
// REDACTED copy to webhook_queue for retry by jobs.js. The retry
// handler rehydrates card fields from the sealed card vault before
// firing, so the queue table never stores PAN/CVV/expiry at rest.
//
// Adversarial audit F2-fulfillment (2026-04-15): the webhook_queue
// INSERT used to run outside its own try/catch. If the INSERT itself
// failed (disk full, constraint violation, lock contention), the
// exception bubbled up past enqueueWebhook's outer `try` — and
// every production caller wraps this function in `.catch(() => {})`
// to keep a customer webhook failure from breaking the order flow.
// Net result: the delivery was lost with zero forensic trace.
//
// Now: inner try/catch around the INSERT, emit a loud bizEvent on
// failure so alerting pipelines see it, still swallow after logging
// so the surrounding order flow still commits.
async function enqueueWebhook(url, payload, webhookSecret) {
  let deliveryErr;
  try {
    await fireWebhook(url, payload, webhookSecret, null);
    return;
  } catch (err) {
    deliveryErr = err;
  }
  const nextAttempt = new Date(Date.now() + WEBHOOK_RETRY_DELAYS_MS[0]).toISOString();
  const errMessage = /** @type {Error} */ (deliveryErr)?.message || String(deliveryErr);
  try {
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
      errMessage,
    );
  } catch (insertErr) {
    bizEvent('webhook.queue_insert_failed', {
      url,
      original_delivery_error: errMessage,
      insert_error: /** @type {Error} */ (insertErr)?.message || String(insertErr),
    });
    console.error(
      `[webhook] failed to persist ${url} to webhook_queue after delivery error — delivery LOST: ` +
        `original=${errMessage}; insert=${/** @type {Error} */ (insertErr)?.message}`,
    );
  }
}

// Validate that a decimal-string amount is a positive, non-zero, well-formed
// number we can hand to the Stellar sender. Protects against corrupt order
// rows (null, "", "0", "-5", "abc") making it into sendUsdc/sendXlm where
// the error would only surface as a cryptic Horizon response.
function isValidRefundAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return false;
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  // Stellar precision is 7 decimal places. Ensure at least one non-zero digit.
  return parseFloat(s) > 0;
}

// Adversarial audit F1-fulfillment (2026-04-15). xlm-sender's submitWithRetry
// now annotates submit failures with `stellarStatus` ('not_landed' | 'applied_
// failed' | 'unknown') and a pre-computed `txHash` (see audit F1-xlm-sender in
// the previous cycle). A refund tx that might have landed during a lost-
// response window — stellarStatus='unknown' — is ambiguous: the tx may be on
// chain, or it may not. The previous catch blocks in scheduleRefund discarded
// both fields, leaving the order in refund_pending with no on-chain hash for
// ops to verify against and no structured telemetry for the reconciler.
//
// This helper persists whatever forensics we do have:
//
//   - If the thrown error carries a txHash (stellarStatus='unknown' or
//     'applied_failed'), write it to orders.refund_stellar_txid so ops can
//     check Horizon directly. The order stays in refund_pending — we DO NOT
//     mark it refunded, because we're not sure the money actually moved.
//
//   - Emit a structured bizEvent (refund.send_failed) capturing order_id,
//     asset, amount, stellarStatus, txHash, and the error message so an
//     alerting pipeline can page on the must-verify states instead of
//     burying them in stdout.
//
// Legacy errors (no stellarStatus marker — e.g. an SDK throw we never
// touched) fall through the same code path but with stellarStatus='legacy'
// so telemetry can distinguish them from the annotated variants.
function recordRefundSendFailure(orderId, asset, amount, err) {
  const txHash = /** @type {any} */ (err)?.txHash || null;
  const stellarStatus = /** @type {any} */ (err)?.stellarStatus || 'legacy';
  // Only write the hash if we actually have one AND the column is still
  // null — a partial rollback from a prior attempt shouldn't get
  // overwritten by a fresh attempt's hash.
  if (txHash) {
    db.prepare(
      `UPDATE orders
       SET refund_stellar_txid = COALESCE(refund_stellar_txid, @txid),
           updated_at = @now
       WHERE id = @id`,
    ).run({ id: orderId, txid: txHash, now: new Date().toISOString() });
  }
  bizEvent('refund.send_failed', {
    order_id: orderId,
    asset,
    amount,
    stellar_status: stellarStatus,
    tx_hash: txHash,
    error: /** @type {Error} */ (err)?.message || String(err),
  });
  // Human-readable status tag for the console log so on-call can quickly
  // tell "must verify on chain" (unknown, applied_failed) from "genuinely
  // failed, safe to retry" (not_landed, legacy).
  const reviewTag =
    stellarStatus === 'unknown' || stellarStatus === 'applied_failed'
      ? 'VERIFY_ON_CHAIN'
      : 'SAFE_TO_RETRY';
  console.log(
    `[refund] ${orderId}: ${asset} refund failed [${stellarStatus}] [${reviewTag}] txHash=${
      txHash || 'none'
    }: ${/** @type {Error} */ (err)?.message} — remains refund_pending`,
  );
}

// Refund the payment for an order. Sends USDC or XLM back to the sender address.
// Called on fulfillment failure (via VCC callback) and on order expiry.
async function scheduleRefund(orderId) {
  // Freeze-first: system-wide freeze must stop automatic treasury outflows
  // before any state transition. Claiming refund_pending while frozen would
  // otherwise commit the order to a drain path that only unfreeze-plus-
  // manual-reconcile could reverse. Leave the order in whatever state it
  // was in so ops can review on unfreeze.
  if (isFrozen()) {
    bizEvent('refund.skipped_frozen', { order_id: orderId });
    console.log(`[refund] ${orderId}: system frozen — refund deferred for ops review`);
    return;
  }

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

  // Explicit asset dispatch. The previous branching treated the USDC path
  // as an else-default which meant any future or corrupt payment_asset
  // value (e.g. null, 'btc', an accidental enum drift) would silently
  // attempt a USDC refund. Now we require one of the known values and
  // route anything else to manual ops review.
  const asset = order.payment_asset;
  const isXlm = asset === 'xlm_soroban' || asset === 'xlm';
  const isUsdc = asset === 'usdc_soroban' || asset === 'usdc';
  if (!isXlm && !isUsdc) {
    bizEvent('refund.unknown_asset', { order_id: orderId, asset });
    console.log(
      `[refund] ${orderId}: unknown payment_asset '${asset}' — remains refund_pending for manual action`,
    );
    return;
  }

  if (isXlm) {
    const xlmAmount = order.payment_xlm_amount;
    if (!isValidRefundAmount(xlmAmount)) {
      console.log(
        `[refund] ${orderId}: invalid payment_xlm_amount '${xlmAmount}' — order remains refund_pending`,
      );
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
      recordRefundSendFailure(orderId, 'xlm', xlmAmount, err);
    }
  } else {
    if (!isValidRefundAmount(order.amount_usdc)) {
      console.log(
        `[refund] ${orderId}: invalid amount_usdc '${order.amount_usdc}' — order remains refund_pending`,
      );
      return;
    }
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
      recordRefundSendFailure(orderId, 'usdc', order.amount_usdc, err);
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
