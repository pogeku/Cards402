// @ts-check
// Agent-facing order API
// POST /orders      — create an order; VCC payment instructions are returned
// GET  /orders/:id  — poll order status (and retrieve card details when delivered)

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { isFrozen } = require('../fulfillment');
const { assertSafeUrl } = require('../lib/ssrf');
const { checkPolicy, recordDecision } = require('../policy');
const { usdToXlm } = require('../payments/xlm-price');
const { sendApprovalEmail, sendSpendAlertEmail } = require('../lib/email');
const { event: bizEvent } = require('../lib/logger');

const router = Router();

// Rate limit order creation per API key — default 60/hour, overridable per key via rate_limit_rpm.
// req.apiKey is set by the auth middleware before this runs.
const orderCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req) => {
    const rpm = req.apiKey?.rate_limit_rpm;
    if (rpm && rpm > 0) return rpm * 60; // convert rpm → per-hour
    return 60; // default 60/hour
  },
  keyGenerator: (req) => req.apiKey?.id || /** @type {any} */ (ipKeyGenerator)(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'rate_limit_exceeded',
      message: "Too many orders created. Check your key's rate_limit_rpm setting.",
    }),
});

// Rate limit status polling — 600/min per API key (10/s, generous but capped)
const orderPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  keyGenerator: (req) => req.apiKey?.id || /** @type {any} */ (ipKeyGenerator)(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'rate_limit_exceeded',
      message: 'Too many status polls. Slow down to at most 10 requests/second.',
    }),
});

// ── Policy preview (exported for use in app.js) ─────────────────────────────

function policyCheck(apiKeyId, amount) {
  const result = checkPolicy(apiKeyId, String(amount));
  const key = /** @type {any} */ (db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId));
  let remaining_daily = null;
  if (key?.policy_daily_limit_usdc) {
    const row = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
      FROM orders
      WHERE api_key_id = ? AND status NOT IN ('expired', 'rejected') AND date(created_at) = date('now')
    `,
        )
        .get(apiKeyId)
    );
    remaining_daily = Math.max(
      0,
      parseFloat(key.policy_daily_limit_usdc) - parseFloat(row.total),
    ).toFixed(2);
  }
  return { ...result, remaining_daily };
}

// ── Budget helper (exported for use in /v1/usage) ─────────────────────────────

function buildBudget(apiKey) {
  const spent = parseFloat(apiKey.total_spent_usdc || '0');
  const limit = apiKey.spend_limit_usdc ? parseFloat(apiKey.spend_limit_usdc) : null;
  return {
    spent_usdc: spent.toFixed(2),
    limit_usdc: limit !== null ? limit.toFixed(2) : null,
    remaining_usdc: limit !== null ? Math.max(0, limit - spent).toFixed(2) : null,
  };
}

// POST /orders — create order, dispatch to VCC, return payment instructions
// Supports Idempotency-Key header: same key within 24h returns the original response.
router.post('/', orderCreateLimiter, async (req, res) => {
  // ── Idempotency check ───────────────────────────────────────────────────────
  const idempotencyKey = req.headers['idempotency-key'];
  const requestFingerprint = idempotencyKey
    ? crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body, Object.keys(req.body || {}).sort()))
        .digest('hex')
    : null;

  if (idempotencyKey) {
    const cached = /** @type {any} */ (
      db
        .prepare(
          `SELECT response_status, response_body, request_fingerprint FROM idempotency_keys WHERE key = ? AND api_key_id = ?`,
        )
        .get(idempotencyKey, req.apiKey.id)
    );
    if (cached) {
      if (cached.request_fingerprint && cached.request_fingerprint !== requestFingerprint) {
        // Audit A-8: structured event so idempotency conflicts show up in
        // metrics. Catches agents that reuse the same key with different
        // payloads — either a bug or an attempt to bypass dedupe.
        bizEvent('idempotency.conflict', {
          api_key_id: req.apiKey.id,
          idempotency_key: idempotencyKey.slice(0, 16),
        });
        return res.status(409).json({
          error: 'idempotency_conflict',
          message: 'Idempotency-Key reused with a different request body.',
        });
      }
      bizEvent('idempotency.cache_hit', {
        api_key_id: req.apiKey.id,
        idempotency_key: idempotencyKey.slice(0, 16),
        cached_status: cached.response_status,
      });
      return res.status(cached.response_status).json(JSON.parse(cached.response_body));
    }
  }

  if (isFrozen()) {
    return res.status(503).json({
      error: 'service_temporarily_unavailable',
      message: 'Card fulfillment is temporarily suspended. Please try again later.',
    });
  }

  const { amount_usdc, webhook_url, metadata } = req.body;

  // Strict decimal validation — reject "10abc" which parseFloat would silently accept as 10
  if (typeof amount_usdc !== 'string' || !/^\d+(\.\d+)?$/.test(amount_usdc.trim())) {
    return res.status(400).json({
      error: 'invalid_amount',
      message: 'amount_usdc must be a decimal number string (e.g. "10.00")',
    });
  }
  const amount = parseFloat(amount_usdc);
  if (!amount || amount <= 0) {
    return res
      .status(400)
      .json({ error: 'invalid_amount', message: 'amount_usdc must be a positive number' });
  }
  if (amount > 1000) {
    return res
      .status(400)
      .json({ error: 'invalid_amount', message: 'amount_usdc cannot exceed $1000.00' });
  }

  // Validate webhook_url upfront — fail fast rather than storing a bad URL
  if (webhook_url) {
    try {
      await assertSafeUrl(webhook_url);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_webhook_url', message: err.message });
    }
  }

  // Validate metadata — must be a plain JSON object if provided
  let metadataStr = null;
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return res
        .status(400)
        .json({ error: 'invalid_metadata', message: 'metadata must be a JSON object' });
    }
    try {
      metadataStr = JSON.stringify(metadata);
    } catch {
      return res
        .status(400)
        .json({ error: 'invalid_metadata', message: 'metadata could not be serialized' });
    }
  }

  // Enforce spend limit — count delivered spend AND in-flight orders
  if (req.apiKey.spend_limit_usdc) {
    const settled = parseFloat(req.apiKey.total_spent_usdc || '0');
    const inFlightRow = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
      FROM orders
      WHERE api_key_id = ? AND status IN ('pending_payment','ordering','refund_pending')
    `,
        )
        .get(req.apiKey.id)
    );
    const inFlight = inFlightRow ? parseFloat(inFlightRow.total) : 0;
    const limit = parseFloat(req.apiKey.spend_limit_usdc);
    if (settled + inFlight + amount > limit) {
      return res.status(403).json({
        error: 'spend_limit_exceeded',
        limit: req.apiKey.spend_limit_usdc,
        spent: req.apiKey.total_spent_usdc,
      });
    }
  }

  // Policy engine — evaluates spend controls before any funds move
  const policyResult = checkPolicy(req.apiKey.id, amount_usdc);

  if (policyResult.decision === 'blocked') {
    return res.status(403).json({
      error: 'policy_blocked',
      rule: policyResult.rule,
      message: policyResult.reason,
    });
  }

  const id = uuidv4();

  // Approval required — create order in awaiting_approval, no VCC job yet
  if (policyResult.decision === 'pending_approval') {
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, api_key_id, webhook_url, request_id)
      VALUES (@id, 'awaiting_approval', @amount_usdc, @api_key_id, @webhook_url, @request_id)
    `,
    ).run({
      id,
      amount_usdc: String(amount),
      api_key_id: req.apiKey.id,
      webhook_url: webhook_url || null,
      request_id: req.id || null,
    });

    const approvalId = uuidv4();
    // Audit A-24: configurable approval TTL. Default 2 hours; operators
    // can tune via APPROVAL_TTL_MINUTES for long-running review workflows.
    const approvalTtlMs =
      Math.max(5, parseInt(process.env.APPROVAL_TTL_MINUTES || '120', 10)) * 60 * 1000;
    const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
    db.prepare(
      `
      INSERT INTO approval_requests (id, api_key_id, order_id, amount_usdc, agent_note, expires_at)
      VALUES (@id, @api_key_id, @order_id, @amount_usdc, @agent_note, @expires_at)
    `,
    ).run({
      id: approvalId,
      api_key_id: req.apiKey.id,
      order_id: id,
      amount_usdc: String(amount),
      agent_note: req.body.note || null,
      expires_at: expiresAt,
    });

    recordDecision(
      req.apiKey.id,
      id,
      String(amount),
      'pending_approval',
      policyResult.rule,
      policyResult.reason,
    );

    notifyOwnerApprovalNeeded({
      approvalId,
      orderId: id,
      amountUsdc: amount_usdc,
      apiKeyId: req.apiKey.id,
      keyLabel: req.apiKey.label,
      reason: policyResult.reason,
    });

    const approvalBody = {
      order_id: id,
      phase: 'awaiting_approval',
      approval_request_id: approvalId,
      amount_usdc: String(amount),
      message: policyResult.reason,
      note: `The account owner has been notified. Poll GET /v1/orders/${id} to check status.`,
      expires_at: expiresAt,
    };

    if (idempotencyKey) {
      db.prepare(
        `INSERT OR IGNORE INTO idempotency_keys (key, api_key_id, request_fingerprint, response_status, response_body) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, req.apiKey.id, requestFingerprint, 202, JSON.stringify(approvalBody));
    }

    return res.status(202).json(approvalBody);
  }

  function respond(status, body) {
    if (idempotencyKey) {
      db.prepare(
        `INSERT OR IGNORE INTO idempotency_keys (key, api_key_id, request_fingerprint, response_status, response_body) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, req.apiKey.id, requestFingerprint, status, JSON.stringify(body));
    }
    return res.status(status).json(body);
  }

  // Sandbox mode — return a fake card instantly, skip VCC and Stellar entirely.
  // F1: even sandbox writes go through sealCard so the storage shape is
  // uniform with prod and the read path doesn't have to branch.
  if (req.apiKey.mode === 'sandbox') {
    const { sealCard } = require('../lib/card-vault');
    const sealed = sealCard({
      number: '4111111111111111',
      cvv: '123',
      expiry: '12/99',
      brand: 'Visa',
    });
    db.prepare(
      `
      INSERT INTO orders (id, status, amount_usdc, api_key_id, webhook_url, metadata, request_id,
                          card_number, card_cvv, card_expiry, card_brand)
      VALUES (@id, 'delivered', @amount_usdc, @api_key_id, @webhook_url, @metadata, @request_id,
              @num, @cvv, @expiry, @brand)
    `,
    ).run({
      id,
      amount_usdc: String(amount),
      api_key_id: req.apiKey.id,
      webhook_url: webhook_url || null,
      metadata: metadataStr,
      request_id: req.id || null,
      num: sealed.number,
      cvv: sealed.cvv,
      expiry: sealed.expiry,
      brand: sealed.brand,
    });

    const sandboxBody = {
      order_id: id,
      status: 'delivered',
      phase: 'ready',
      amount_usdc: String(amount),
      sandbox: true,
      card: { number: '4111111111111111', cvv: '123', expiry: '12/99', brand: 'Visa' },
    };
    return respond(201, sandboxBody);
  }

  // Build Soroban contract payment instructions — agent pays the contract directly.
  // The watcher in index.js picks up the payment event and kicks off VCC fulfillment.
  let xlmAmount = null;
  try {
    xlmAmount = await usdToXlm(String(amount));
  } catch (err) {
    console.warn(`[orders] XLM price lookup failed: ${err.message}`);
  }

  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const contractPayment = {
    type: 'soroban_contract',
    contract_id: process.env.RECEIVER_CONTRACT_ID,
    order_id: id,
    usdc: { amount: String(amount), asset: `USDC:${USDC_ISSUER}` },
    ...(xlmAmount && { xlm: { amount: xlmAmount } }),
  };

  db.prepare(
    `
    INSERT INTO orders (id, status, amount_usdc, expected_xlm_amount, api_key_id,
                        webhook_url, metadata, vcc_payment_json, request_id)
    VALUES (@id, 'pending_payment', @amount_usdc, @expected_xlm_amount, @api_key_id,
            @webhook_url, @metadata, @vcc_payment_json, @request_id)
  `,
  ).run({
    id,
    amount_usdc: String(amount),
    // xlmAmount is the XLM quote embedded in the Soroban payment instructions.
    // Null if the price oracle was down at create time, in which case we
    // only accept pay_usdc events for this order — the xlm branch is closed.
    expected_xlm_amount: xlmAmount || null,
    api_key_id: req.apiKey.id,
    webhook_url: webhook_url || null,
    metadata: metadataStr,
    vcc_payment_json: JSON.stringify(contractPayment),
    request_id: req.id || null,
  });

  const freshKey = /** @type {any} */ (
    db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(req.apiKey.id)
  );
  const budget = buildBudget(freshKey);

  // Spend alert — notify owner if key is near daily or total limit
  checkSpendAlert(req.apiKey.id, amount).catch(() => {});

  const responseBody = {
    order_id: id,
    status: 'pending_payment',
    phase: 'awaiting_payment',
    amount_usdc: String(amount),
    payment: contractPayment,
    poll_url: `/v1/orders/${id}`,
    budget,
  };

  return respond(201, responseBody);
});

// GET /orders — list agent's own orders.
// Audit A-19: supports `since_created_at` / `since_updated_at` ISO-8601
// timestamps so agents can poll for new orders without re-fetching the
// whole history, plus `offset` for simple pagination and a tighter hard
// cap on `limit` (200 from the previous 100 to support larger polling
// windows without exceeding DB response size).
router.get('/', orderPollLimiter, (req, res) => {
  const { status, limit = 20, offset = 0, since_created_at, since_updated_at } = req.query;
  let query = `SELECT id, status, amount_usdc, payment_asset, created_at, updated_at FROM orders WHERE api_key_id = ?`;
  const params = [req.apiKey.id];
  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }
  if (since_created_at) {
    query += ` AND created_at >= ?`;
    params.push(String(since_created_at));
  }
  if (since_updated_at) {
    query += ` AND updated_at >= ?`;
    params.push(String(since_updated_at));
  }
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(parseInt(String(limit)) || 20, 200));
  params.push(Math.max(parseInt(String(offset)) || 0, 0));
  res.json(db.prepare(query).all(...params));
});

// Map internal pipeline statuses → stable agent-facing phase
const PHASE = {
  awaiting_approval: 'awaiting_approval',
  pending_payment: 'awaiting_payment',
  expired: 'expired',
  rejected: 'rejected',
  ordering: 'processing',
  delivered: 'ready',
  failed: 'failed',
  refund_pending: 'failed',
  refunded: 'refunded',
};

// Build the public-facing payload for an order row. Shared by GET /:id and
// GET /:id/stream so both return exactly the same shape.
function buildOrderResponse(order) {
  const response = {
    order_id: order.id,
    status: order.status,
    phase: PHASE[order.status] ?? 'processing',
    amount_usdc: order.amount_usdc,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };

  if (order.status === 'awaiting_approval') {
    const approval = /** @type {any} */ (
      db
        .prepare(`SELECT id, expires_at, status FROM approval_requests WHERE order_id = ?`)
        .get(order.id)
    );
    response.approval_request_id = approval?.id ?? null;
    response.note = 'Awaiting owner approval. The account owner has been notified.';
    response.expires_at = approval?.expires_at ?? null;
  }

  if (order.status === 'pending_payment' && order.vcc_payment_json) {
    try {
      response.payment = JSON.parse(order.vcc_payment_json);
    } catch {
      /* malformed JSON — omit payment */
    }
  }

  if (order.status === 'delivered') {
    // F1: card_number/cvv/expiry are sealed at rest. openCard pass-throughs
    // plaintext rows during the upgrade window so legacy orders still work.
    const { openCard } = require('../lib/card-vault');
    const { normalizeCardBrand } = require('../lib/normalize-card');
    const card = openCard(order);
    if (card) {
      // Replace the raw upstream brand (e.g. "Visa® Reward Card, 6-Month
      // Expiration [ITNL] eGift Card") with a stable agent-facing label
      // before sending to the agent. The raw brand stays in the DB row
      // for ops/audit but never reaches the agent transcript.
      card.brand = normalizeCardBrand(card.brand);
    }
    response.card = card;
  }

  if (order.status === 'expired') {
    response.note = 'Payment window expired. No funds were taken.';
  }

  if (order.status === 'rejected') {
    response.error = order.error ?? 'rejected_by_owner';
    response.note = 'This transaction was rejected. No funds were taken.';
  }

  if (['failed', 'refund_pending', 'refunded'].includes(order.status)) {
    response.error = order.error;
    if (order.status === 'refunded') {
      response.refund = { stellar_txid: order.refund_stellar_txid };
    }
  }

  if (order.metadata) {
    try {
      response.metadata = JSON.parse(order.metadata);
    } catch {
      /* skip malformed */
    }
  }

  return response;
}

const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'refunded', 'expired', 'rejected']);

// GET /orders/:id/stream — SSE stream of phase transitions.
//
// Replaces HTTP polling for long-lived agents: one open connection gets
// pushed every state change until the order reaches a terminal phase, at
// which point the server closes the stream. Internal implementation is a
// 500ms SQLite tick per connection (cheap at our current scale; swap for an
// in-process EventEmitter later if fanout grows).
//
// Client protocol (standard SSE):
//   event: phase
//   id: <ms-since-epoch of updated_at>
//   data: <same JSON body as GET /orders/:id>
//
// Reconnection: each event carries the full current state, so a client can
// reopen the stream at any time and rebuild its view from the first event
// without needing Last-Event-ID replay.
router.get('/:id/stream', (req, res) => {
  const orderId = req.params.id;
  const keyId = req.apiKey.id;

  const initial = /** @type {any} */ (
    db.prepare(`SELECT * FROM orders WHERE id = ? AND api_key_id = ?`).get(orderId, keyId)
  );
  if (!initial) {
    return res.status(404).json({ error: 'order_not_found' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx to pass bytes straight through
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  let lastUpdated = '';
  let closed = false;

  function emit(row) {
    const payload = buildOrderResponse(row);
    const id = Date.parse(row.updated_at) || Date.now();
    res.write(`id: ${id}\nevent: phase\ndata: ${JSON.stringify(payload)}\n\n`);
    return TERMINAL_STATUSES.has(row.status);
  }

  // Initial state — so reconnects always see current phase on first message.
  lastUpdated = initial.updated_at;
  if (emit(initial)) {
    res.end();
    return;
  }

  const tick = setInterval(() => {
    if (closed) return;
    const row = /** @type {any} */ (
      db.prepare(`SELECT * FROM orders WHERE id = ? AND api_key_id = ?`).get(orderId, keyId)
    );
    if (!row) {
      clearInterval(tick);
      clearInterval(keepalive);
      res.end();
      return;
    }
    if (row.updated_at !== lastUpdated) {
      lastUpdated = row.updated_at;
      if (emit(row)) {
        clearInterval(tick);
        clearInterval(keepalive);
        res.end();
      }
    }
  }, 500);

  // SSE comment ping every 15s so intermediate proxies don't idle-kill.
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(tick);
    clearInterval(keepalive);
  });
});

// GET /orders/:id — poll status, returns card details when delivered
router.get('/:id', orderPollLimiter, (req, res) => {
  const order = /** @type {any} */ (
    db
      .prepare(`SELECT * FROM orders WHERE id = ? AND api_key_id = ?`)
      .get(req.params.id, req.apiKey.id)
  );
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  res.json(buildOrderResponse(order));
});

// Notify owner via Discord + email when an approval is needed
async function notifyOwnerApprovalNeeded({
  approvalId,
  orderId,
  amountUsdc,
  apiKeyId,
  keyLabel,
  reason,
}) {
  const label = keyLabel ? `"${keyLabel}"` : apiKeyId.slice(0, 8);

  // Discord
  const discordUrl = process.env.DISCORD_WEBHOOK_OWNER;
  if (discordUrl) {
    fetch(discordUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: `⏳ Approval required — $${amountUsdc}`,
            description: reason,
            color: 0xfbbf24,
            fields: [
              { name: 'Agent', value: label, inline: true },
              { name: 'Amount', value: `$${amountUsdc} USDC`, inline: true },
              { name: 'Order', value: orderId.slice(0, 8), inline: true },
            ],
            footer: { text: `Approval ID: ${approvalId} · Expires in 2h` },
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }

  // Email to owner
  try {
    const ownerRow = /** @type {any} */ (
      db.prepare(`SELECT email FROM users WHERE role = 'owner' LIMIT 1`).get()
    );
    if (ownerRow?.email) {
      await sendApprovalEmail(ownerRow.email, {
        approvalId,
        orderId,
        amountUsdc,
        keyLabel: label,
        reason,
      });
    }
  } catch {
    /* non-critical */
  }
}

// Fire-and-forget spend alert when an order is placed.
// Alerts at 80% and 90% of daily and total limits.
// Uses system_state to debounce — only alerts once per threshold crossing.
async function checkSpendAlert(apiKeyId, newAmount) {
  const key = /** @type {any} */ (db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId));
  if (!key) return;
  const ownerRow = /** @type {any} */ (
    db.prepare(`SELECT email FROM users WHERE role = 'owner' LIMIT 1`).get()
  );
  if (!ownerRow?.email) return;

  const label = key.label || apiKeyId.slice(0, 8);
  const THRESHOLDS = [80, 90, 100];

  // Total spend limit
  if (key.spend_limit_usdc) {
    const limit = parseFloat(key.spend_limit_usdc);
    const spent = parseFloat(key.total_spent_usdc || '0') + parseFloat(newAmount);
    const pct = Math.floor((spent / limit) * 100);
    for (const threshold of THRESHOLDS) {
      if (pct >= threshold) {
        const alertKey = `spend_alert:${apiKeyId}:total:${threshold}`;
        const already = db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(alertKey);
        if (!already) {
          db.prepare(`INSERT OR IGNORE INTO system_state (key, value) VALUES (?, '1')`).run(
            alertKey,
          );
          sendSpendAlertEmail(ownerRow.email, {
            keyLabel: label,
            pct: threshold,
            spentUsdc: spent.toFixed(2),
            limitUsdc: key.spend_limit_usdc,
            limitType: 'total',
          }).catch(() => {});
        }
        break;
      }
    }
  }

  // Daily limit
  if (key.policy_daily_limit_usdc) {
    const limit = parseFloat(key.policy_daily_limit_usdc);
    const row = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
      FROM orders
      WHERE api_key_id = ? AND status NOT IN ('expired', 'rejected') AND date(created_at) = date('now')
    `,
        )
        .get(apiKeyId)
    );
    const spentToday = parseFloat(row.total) + parseFloat(newAmount);
    const pct = Math.floor((spentToday / limit) * 100);
    const today = new Date().toISOString().slice(0, 10);
    for (const threshold of THRESHOLDS) {
      if (pct >= threshold) {
        const alertKey = `spend_alert:${apiKeyId}:daily:${threshold}:${today}`;
        const already = db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(alertKey);
        if (!already) {
          db.prepare(`INSERT OR IGNORE INTO system_state (key, value) VALUES (?, '1')`).run(
            alertKey,
          );
          sendSpendAlertEmail(ownerRow.email, {
            keyLabel: label,
            pct: threshold,
            spentUsdc: spentToday.toFixed(2),
            limitUsdc: key.policy_daily_limit_usdc,
            limitType: 'daily',
          }).catch(() => {});
        }
        break;
      }
    }
  }
}

module.exports = router;
module.exports.buildBudget = buildBudget;
module.exports.policyCheck = policyCheck;
