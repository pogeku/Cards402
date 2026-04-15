// @ts-check
// VCC callback handler — receives fulfillment results from the VCC service.
// Called by VCC when a job completes (fulfilled or failed).
// Auth: HMAC-SHA256 signature on the raw request body (not session auth).

const { Router } = require('express');
const db = require('../db');
const { enqueueWebhook, scheduleRefund } = require('../fulfillment');
const { verifyVccSignature } = require('../vcc-client');
const { sealCard } = require('../lib/card-vault');
const { normalizeCardBrand } = require('../lib/normalize-card');
const { event: bizEvent } = require('../lib/logger');
const { recordAudit } = require('../lib/audit');

// Look up the dashboard that owns an order so vcc-callback can write
// audit rows scoped to it. Returns null if the order has no api_key
// or the api_key has no dashboard — which shouldn't happen in
// practice but we defensively log instead of throwing.
function dashboardIdForOrder(orderId) {
  const row = /** @type {any} */ (
    db
      .prepare(
        `SELECT k.dashboard_id AS dashboard_id
         FROM orders o
         LEFT JOIN api_keys k ON o.api_key_id = k.id
         WHERE o.id = ?`,
      )
      .get(orderId)
  );
  return row?.dashboard_id || null;
}

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

  // Adversarial audit F1/F2 (2026-04-15): the pre-verification order-row
  // read is the anchor for two downgrade attacks that existed in the
  // original handler:
  //
  //   F1 — Nonce bypass: when an order was minted with a callback_nonce
  //        (v3), the original handler only rejected a mismatch when both
  //        sides were non-null. An attacker who knew the shared secret
  //        but NOT the per-order nonce could omit X-VCC-Nonce entirely
  //        and the verifier would fall through to v2 (which doesn't bind
  //        the nonce). Fix: if the row has a callback_nonce, the header
  //        nonce is mandatory AND must match, and we set requireV3 on
  //        the verifier call so v2 fallback is disabled in hmac.js too.
  //
  //   F2 — Per-order secret silent fallback: when an order has a sealed
  //        callback_secret and secret-box.open() throws (key rotation,
  //        corrupted ciphertext, truncated row), the original handler
  //        swallowed the error and fell through to VCC_CALLBACK_SECRET,
  //        silently downgrading to the pre-F2 shared-secret model. Fix:
  //        if the row carries a non-NULL callback_secret, decrypt
  //        failure is a hard reject. The legitimate "legacy order" path
  //        is `callback_secret IS NULL`, not "we tried and failed".
  //
  // Both fixes depend on reading the row BEFORE signature verification
  // so we know whether to require v3 and whether to tolerate a NULL
  // per-order secret.
  let storedNonce = null;
  let perOrderSecret = null;
  let orderHasPerOrderSecret = false;
  let orderExistsForPreCheck = false;

  if (headerOrderId) {
    const row = /** @type {any} */ (
      db
        .prepare(`SELECT id, callback_nonce, callback_secret FROM orders WHERE id = ?`)
        .get(headerOrderId)
    );
    if (row) {
      orderExistsForPreCheck = true;
      if (row.callback_nonce) storedNonce = row.callback_nonce;
      if (row.callback_secret) {
        orderHasPerOrderSecret = true;
        try {
          const { open } = require('../lib/secret-box');
          perOrderSecret = open(row.callback_secret);
        } catch (err) {
          // F2 fix: fail-closed. The row has a non-NULL per-order secret;
          // if we can't open it we refuse the callback outright instead of
          // downgrading to VCC_CALLBACK_SECRET. An ops-visible alert plus
          // a 401 on the wire. This differs from legacy orders (row exists
          // but callback_secret IS NULL), which still fall through to the
          // env secret below.
          console.warn(
            `[vcc-callback] per-order callback_secret decrypt failed for ${headerOrderId}: ${err.message}`,
          );
          bizEvent('callback.rejected', {
            reason: 'per_order_secret_unavailable',
            order_id: headerOrderId,
            error: err.message,
          });
          return res.status(401).json({ error: 'invalid_signature' });
        }
      }
    }

    // F1 fix: nonce enforcement is now mandatory when the row has one.
    // The header MUST be present AND must match — no "if both present"
    // shortcut. This is the anchor check that prevents an attacker from
    // downgrading to v2 by simply not sending X-VCC-Nonce.
    if (storedNonce) {
      if (!headerNonce || headerNonce !== storedNonce) {
        bizEvent('callback.rejected', {
          reason: !headerNonce ? 'nonce_missing' : 'nonce_mismatch',
          order_id: headerOrderId,
        });
        return res.status(401).json({ error: 'invalid_signature' });
      }
    }
  }

  // Any order enrolled in the v3 protocol (has a stored nonce or a
  // per-order secret) must be verified under v3. requireV3 disables the
  // v2 fallback inside verifyCallback even if some other code path ever
  // drops storedNonce before calling in. Belt-and-braces: the mandatory
  // nonce check above already kills v2-downgrade attacks, but paying
  // the library-level cost of rejecting v2 signatures here closes the
  // attack class at both layers.
  const requireV3 = Boolean(storedNonce) || orderHasPerOrderSecret;

  const rawBody = req.rawBody;
  const verdict = verifyVccSignature(
    rawBody,
    signature,
    timestamp,
    headerOrderId,
    storedNonce,
    perOrderSecret,
    { requireV3 },
  );
  if (!verdict.ok) {
    bizEvent('callback.rejected', {
      reason: verdict.reason,
      order_id: headerOrderId || null,
      require_v3: requireV3,
    });
    return res.status(401).json({ error: WIRE_ERROR[verdict.reason] || 'invalid_signature' });
  }
  // Guard against the unlikely case where the row vanished between the
  // pre-check and the main SELECT below. Not a security issue — just
  // avoids a confusing 404 after a successful signature verify.
  void orderExistsForPreCheck;

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
    // F1: seal PAN/CVV/expiry before writing. The seal helper throws in
    // production when CARDS402_SECRET_BOX_KEY is unset (F5 enforced it at
    // env validation time, so this is belt-and-braces). card_brand stays
    // plaintext — Visa/Mastercard isn't sensitive.
    const sealed = sealCard(card);
    const claimed = db
      .prepare(
        `
      UPDATE orders
      SET status = 'delivered', card_number = @num, card_cvv = @cvv,
          card_expiry = @expiry, card_brand = @brand, updated_at = @now
      WHERE id = @id AND status NOT IN ('delivered', 'failed', 'refunded', 'refund_pending')
    `,
      )
      .run({
        id: order_id,
        num: sealed.number,
        cvv: sealed.cvv,
        expiry: sealed.expiry,
        brand: sealed.brand,
        now,
      });
    if (claimed.changes === 0) {
      // Another callback reached terminal state in the race window.
      return res.json({ ok: true, note: 'already_terminal_race' });
    }

    // Track spend per API key
    if (order.api_key_id) {
      db.prepare(
        `
        UPDATE api_keys
        SET total_spent_usdc = printf('%.2f', CAST(total_spent_usdc AS REAL) + CAST(@amount AS REAL))
        WHERE id = @id
      `,
      ).run({ id: order.api_key_id, amount: order.amount_usdc });
    }

    bizEvent('order.fulfilled', {
      order_id,
      amount_usd: order.amount_usdc,
      payment_asset: order.payment_asset,
      api_key_id: order.api_key_id,
    });
    // Audit row for the external ingress writing to order state.
    // VCC callbacks are HMAC-verified but still EXTERNAL — an
    // attacker with a leaked secret or a MITM'd callback would
    // otherwise write to orders with zero forensic trail. The
    // audit row captures the transition, the card brand, and the
    // amount so post-incident reconstruction can differentiate a
    // legitimate fulfilment from a replayed callback.
    const dashId = dashboardIdForOrder(order_id);
    if (dashId) {
      recordAudit({
        dashboardId: dashId,
        actor: { id: null, email: 'vcc-callback', role: 'system' },
        action: 'order.fulfilled',
        resourceType: 'order',
        resourceId: order_id,
        details: {
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          card_brand: normalizeCardBrand(card.brand),
          api_key_id: order.api_key_id,
        },
        ip: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null,
      });
    }

    // Fire agent delivery webhook. Audit A-33: include amount + payment
    // asset so the agent can reconcile without an extra /v1/orders fetch.
    const keyRow = /** @type {any} */ (
      order.api_key_id
        ? db
            .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
            .get(order.api_key_id)
        : null
    );
    const webhookUrl = order.webhook_url || keyRow?.default_webhook_url || null;
    if (webhookUrl) {
      enqueueWebhook(
        webhookUrl,
        {
          order_id,
          status: 'delivered',
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          card: {
            number: card.number,
            cvv: card.cvv,
            expiry: card.expiry,
            // Normalise the upstream merchant-catalog string before it
            // hits the agent transcript. Raw value stays in the orders
            // row for ops; agents see "USD Visa Card" not "Visa® Reward
            // Card, 6-Month Expiration [ITNL] eGift Card".
            brand: normalizeCardBrand(card.brand),
          },
        },
        keyRow?.webhook_secret || null,
      ).catch(() => {});
    }
  } else if (status === 'failed') {
    // Sanitise vcc's verbose internal error into a public-facing one
    // before writing to orders.error. Agents read this column via
    // /v1/orders/:id and the SSE stream, so leaking 'stage2 failed:
    // playwright launch ...' or 'vcc invoice failed: HTTP 502
    // {ctx_error: ...}' would expose every layer of the fulfillment
    // pipeline. Raw error is still logged via bizEvent below for ops.
    const { publicMessage } = require('../lib/sanitize-error');
    const safeError = publicMessage(error || 'fulfillment_failed');
    const claimed = db
      .prepare(
        `
      UPDATE orders SET status = 'failed', error = @error, updated_at = @now
      WHERE id = @id AND status NOT IN ('delivered', 'failed', 'refunded', 'refund_pending')
    `,
      )
      .run({ id: order_id, error: safeError, now });
    if (claimed.changes === 0) {
      return res.json({ ok: true, note: 'already_terminal_race' });
    }

    // Audit row for the failed transition — same rationale as the
    // fulfilled branch above.
    const dashId = dashboardIdForOrder(order_id);
    if (dashId) {
      recordAudit({
        dashboardId: dashId,
        actor: { id: null, email: 'vcc-callback', role: 'system' },
        action: 'order.failed',
        resourceType: 'order',
        resourceId: order_id,
        details: {
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          api_key_id: order.api_key_id,
          error: safeError,
        },
        ip: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null,
      });
    }

    bizEvent('order.failed', {
      order_id,
      amount_usd: order.amount_usdc,
      payment_asset: order.payment_asset,
      api_key_id: order.api_key_id,
      error,
    });

    // Fire agent failure webhook
    const failedOrder = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT o.webhook_url, k.webhook_secret, k.default_webhook_url
      FROM orders o LEFT JOIN api_keys k ON o.api_key_id = k.id
      WHERE o.id = ?
    `,
        )
        .get(order_id)
    );
    const failureWebhookUrl = failedOrder?.webhook_url || failedOrder?.default_webhook_url || null;
    if (failureWebhookUrl) {
      // Use the same sanitised error in the outbound webhook so a
      // listening agent doesn't get the raw vcc/scraper string either.
      enqueueWebhook(
        failureWebhookUrl,
        {
          order_id,
          status: 'failed',
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          error: safeError,
        },
        failedOrder?.webhook_secret || null,
      ).catch(() => {});
    }

    // cards402 holds the funds — issue a refund to the agent
    scheduleRefund(order_id).catch(() => {});
  } else {
    return res.status(400).json({ error: 'invalid_status' });
  }

  res.json({ ok: true });
});

module.exports = router;
