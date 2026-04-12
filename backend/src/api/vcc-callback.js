// @ts-check
// VCC callback handler — receives fulfillment results from the VCC service.
// Called by VCC when a job completes (fulfilled or failed).
// Auth: HMAC-SHA256 signature on the raw request body (not session auth).

const { Router } = require('express');
const db = require('../db');
const { enqueueWebhook, scheduleRefund } = require('../fulfillment');
const { verifyVccSignature } = require('../vcc-client');
const { event: bizEvent } = require('../lib/logger');

const router = Router();

// POST /vcc-callback
// Body: { order_id, status: 'fulfilled'|'failed', card?: { number, cvv, expiry, brand }, error?: string }
// Headers: X-VCC-Signature: sha256=<hmac>, X-VCC-Timestamp: <epoch_ms>
router.post('/', (req, res) => {
  const signature = req.headers['x-vcc-signature'];
  const timestamp = req.headers['x-vcc-timestamp'];
  const headerOrderId = req.headers['x-vcc-order-id']; // v2+
  const headerNonce = req.headers['x-vcc-nonce']; // v3 — per-job nonce (audit C-3)
  const upstreamRequestId = req.headers['x-request-id'];

  // Audit C-1: if vcc echoes a request id, emit a correlation log line
  // before the verification branches so traces line up on rejected
  // callbacks too.
  if (upstreamRequestId && upstreamRequestId !== req.id) {
    bizEvent('callback.received', {
      upstream_request_id: upstreamRequestId,
      local_request_id: req.id,
      order_id: headerOrderId || null,
    });
  }

  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'missing_signature' });
  }

  // req.rawBody is set by the express.json verify callback in app.js.
  // verifyVccSignature now enforces its own replay window (10 min) and
  // returns a structured verdict so we can metric the rejection reason.
  // Wire error strings are stabilised to the original names so existing
  // clients and tests don't break; the richer reason goes to telemetry.
  const WIRE_ERROR = {
    missing_fields: 'missing_signature',
    timestamp_expired: 'timestamp_expired',
    bad_signature: 'invalid_signature',
  };
  // Audit C-3: if the callback includes a nonce header (v3), look up the
  // stored nonce on the order so the verifier can include it in the HMAC
  // payload. If the order doesn't exist yet (race), skip nonce verification
  // and let the v2/v1 fallback paths handle it.
  let storedNonce = null;
  if (headerNonce && headerOrderId) {
    const row = /** @type {any} */ (db.prepare(`SELECT callback_nonce FROM orders WHERE id = ?`).get(headerOrderId));
    const effectiveNonce = row?.callback_nonce || null;
    const effectiveHeader = headerNonce || null;
    storedNonce = effectiveNonce;
    if (effectiveNonce && effectiveHeader && effectiveNonce !== effectiveHeader) {
      bizEvent('callback.rejected', { reason: 'nonce_mismatch', order_id: headerOrderId });
      return res.status(401).json({ error: 'invalid_signature' });
    }
  }

  const rawBody = req.rawBody;
  const verdict = verifyVccSignature(rawBody, signature, timestamp, headerOrderId, storedNonce);
  if (!verdict.ok) {
    bizEvent('callback.rejected', {
      reason: verdict.reason,
      order_id: headerOrderId || null,
    });
    return res.status(401).json({ error: WIRE_ERROR[verdict.reason] || 'invalid_signature' });
  }

  const { order_id, status, card, error } = req.body;
  if (!order_id || !status) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  // Defence in depth: if the caller provided an X-VCC-Order-Id header (v2)
  // it must match the body. Prevents an attacker from swapping bodies across
  // signed envelopes even in the unlikely event they ever get both.
  if (headerOrderId && headerOrderId !== order_id) {
    bizEvent('callback.rejected', {
      reason: 'order_id_mismatch',
      header_order_id: headerOrderId,
      body_order_id: order_id,
    });
    return res.status(400).json({ error: 'order_id_mismatch' });
  }

  const order = /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order_id));
  if (!order) {
    return res.status(404).json({ error: 'order_not_found' });
  }

  // Audit C-6: use an atomic claim-style UPDATE instead of separate
  // SELECT + UPDATE. Prevents two concurrent callbacks (e.g. vcc retry
  // arriving while the first is still processing) from both entering
  // the success branch and double-writing card data.
  const now = new Date().toISOString();
  const TERMINAL = ['delivered', 'failed', 'refunded', 'refund_pending'];
  if (TERMINAL.includes(order.status)) {
    return res.json({ ok: true, note: 'already_terminal' });
  }

  if (status === 'fulfilled' && card) {
    const claimed = db.prepare(`
      UPDATE orders
      SET status = 'delivered', card_number = @num, card_cvv = @cvv,
          card_expiry = @expiry, card_brand = @brand, updated_at = @now
      WHERE id = @id AND status NOT IN ('delivered', 'failed', 'refunded', 'refund_pending')
    `).run({ id: order_id, num: card.number, cvv: card.cvv, expiry: card.expiry, brand: card.brand || null, now });
    if (claimed.changes === 0) {
      // Another callback reached terminal state in the race window.
      return res.json({ ok: true, note: 'already_terminal_race' });
    }

    // Track spend per API key
    if (order.api_key_id) {
      db.prepare(`
        UPDATE api_keys
        SET total_spent_usdc = printf('%.2f', CAST(total_spent_usdc AS REAL) + CAST(@amount AS REAL))
        WHERE id = @id
      `).run({ id: order.api_key_id, amount: order.amount_usdc });
    }

    bizEvent('order.fulfilled', {
      order_id,
      amount_usd: order.amount_usdc,
      payment_asset: order.payment_asset,
      api_key_id: order.api_key_id,
    });

    // Fire agent delivery webhook. Audit A-33: include amount + payment
    // asset so the agent can reconcile without an extra /v1/orders fetch.
    const keyRow = /** @type {any} */ (order.api_key_id
      ? db.prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`).get(order.api_key_id)
      : null);
    const webhookUrl = order.webhook_url || keyRow?.default_webhook_url || null;
    if (webhookUrl) {
      enqueueWebhook(webhookUrl, {
        order_id,
        status: 'delivered',
        amount_usdc: order.amount_usdc,
        payment_asset: order.payment_asset,
        card: { number: card.number, cvv: card.cvv, expiry: card.expiry, brand: card.brand || null },
      }, keyRow?.webhook_secret || null).catch(() => {});
    }

  } else if (status === 'failed') {
    const claimed = db.prepare(`
      UPDATE orders SET status = 'failed', error = @error, updated_at = @now
      WHERE id = @id AND status NOT IN ('delivered', 'failed', 'refunded', 'refund_pending')
    `).run({ id: order_id, error: error || 'fulfillment_failed', now });
    if (claimed.changes === 0) {
      return res.json({ ok: true, note: 'already_terminal_race' });
    }

    bizEvent('order.failed', {
      order_id,
      amount_usd: order.amount_usdc,
      payment_asset: order.payment_asset,
      api_key_id: order.api_key_id,
      error,
    });

    // Fire agent failure webhook
    const failedOrder = /** @type {any} */ (db.prepare(`
      SELECT o.webhook_url, k.webhook_secret, k.default_webhook_url
      FROM orders o LEFT JOIN api_keys k ON o.api_key_id = k.id
      WHERE o.id = ?
    `).get(order_id));
    const failureWebhookUrl = failedOrder?.webhook_url || failedOrder?.default_webhook_url || null;
    if (failureWebhookUrl) {
      enqueueWebhook(failureWebhookUrl, {
        order_id,
        status: 'failed',
        amount_usdc: order.amount_usdc,
        payment_asset: order.payment_asset,
        error: error || 'fulfillment_failed',
      }, failedOrder?.webhook_secret || null).catch(() => {});
    }

    // cards402 holds the funds — issue a refund to the agent
    scheduleRefund(order_id).catch(() => {});

  } else {
    return res.status(400).json({ error: 'invalid_status' });
  }

  res.json({ ok: true });
});

module.exports = router;
