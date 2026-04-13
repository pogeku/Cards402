// @ts-check
// Admin API — operator dashboard backend
// All routes require a valid session (requireAuth).
// Destructive/financial operations additionally require owner role (requireOwner).

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
/** @type {any} */ const db = require('../db');
const { scheduleRefund, enqueueWebhook, fireWebhook } = require('../fulfillment');
const { assertSafeUrl } = require('../lib/ssrf');
const { recordDecision } = require('../policy');
const { usdToXlm } = require('../payments/xlm-price');
const requireAuth = require('../middleware/requireAuth');
const requireOwner = require('../middleware/requireOwner');
const { event: bizEvent } = require('../lib/logger');
const { recordAdminAction } = require('../lib/admin-audit');
const { getOrderStats } = require('../lib/stats');

const router = Router();

// All admin routes require owner (super-admin) role.
// Regular users manage their own dashboards via /dashboard/*.
router.use(requireAuth, requireOwner);

// GET /admin/stream — Server-Sent Events feed of every state change
// the admin dashboard cares about. Replaces the legacy 30s polling
// refresh loop — clients get pushed to on every order transition,
// approval decision, agent_state change, and system event, and should
// refetch the full snapshot (stats, orders, keys, approvals) once on
// connect and then patch incrementally.
router.get('/stream', (req, res) => {
  const { subscribe } = require('../lib/event-bus');

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  function send(type, payload) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  send('ready', { at: new Date().toISOString() });

  const unsubscribe = subscribe((evt) => {
    // Admin sees everything; no per-dashboard filtering.
    send(evt.type, evt);
  });

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

// GET /admin/dashboards — all tenants with summary stats
router.get('/dashboards', (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT d.id, d.name, d.spend_limit_usdc, d.frozen, d.created_at,
           u.email AS owner_email,
           COUNT(DISTINCT k.id) AS key_count,
           COUNT(DISTINCT o.id) AS order_count,
           COALESCE(SUM(CAST(o.amount_usdc AS REAL)), 0) AS total_gmv
    FROM dashboards d
    LEFT JOIN users u ON d.user_id = u.id
    LEFT JOIN api_keys k ON k.dashboard_id = d.id
    LEFT JOIN orders o ON o.api_key_id = k.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `,
    )
    .all();
  res.json(rows);
});

// GET /admin/orders — list all orders with optional search/filter/CSV export.
// Audit A-13: accepts an optional `dashboard_id` filter (joins via api_keys
// → dashboards). Audit A-9: CSV export now streams row-by-row with a small
// cap instead of loading the entire result set into memory.
router.get('/orders', (req, res) => {
  const {
    status,
    limit = 50,
    api_key_id,
    dashboard_id,
    search,
    from,
    to,
    format,
    offset = 0,
  } = req.query;
  let query = `
    SELECT o.id, o.status, o.amount_usdc, o.payment_asset, o.stellar_txid,
           o.sender_address, o.refund_stellar_txid, o.metadata,
           o.card_brand, o.error, o.created_at, o.updated_at,
           k.label AS api_key_label, k.dashboard_id
    FROM orders o
    LEFT JOIN api_keys k ON o.api_key_id = k.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    query += ` AND o.status = ?`;
    params.push(status);
  }
  if (api_key_id) {
    query += ` AND o.api_key_id = ?`;
    params.push(api_key_id);
  }
  if (dashboard_id) {
    query += ` AND k.dashboard_id = ?`;
    params.push(dashboard_id);
  }
  if (search) {
    query += ` AND (o.id LIKE ? OR k.label LIKE ?)`;
    params.push(`${search}%`, `%${search}%`);
  }
  if (from) {
    query += ` AND date(o.created_at) >= ?`;
    params.push(from);
  }
  if (to) {
    query += ` AND date(o.created_at) <= ?`;
    params.push(to);
  }
  query += ` ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;

  if (format === 'csv') {
    // Stream CSV row-by-row. `iterate()` on better-sqlite3 yields rows
    // without materialising the whole result set — safe even if `limit`
    // is raised to its hard cap (20k). Cap is higher than the JSON path
    // because CSV is typically used for exports to external tools and an
    // operator who asks for 20k rows is opting into a large download.
    params.push(Math.min(parseInt(String(limit)) || 5000, 20000));
    params.push(Math.max(parseInt(String(offset)) || 0, 0));

    const cols = [
      'id',
      'created_at',
      'status',
      'amount_usdc',
      'payment_asset',
      'api_key_label',
      'card_brand',
      'stellar_txid',
      'error',
    ];
    const escape = (v) =>
      v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
    res.write(cols.join(',') + '\n');
    for (const row of db.prepare(query).iterate(...params)) {
      res.write(cols.map((c) => escape(/** @type {any} */ (row)[c])).join(',') + '\n');
    }
    return res.end();
  }

  params.push(Math.min(parseInt(String(limit)) || 50, 500));
  params.push(Math.max(parseInt(String(offset)) || 0, 0));
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// GET /admin/stats — aggregate spend and order stats.
// Audit A-18: uses shared getOrderStats() to avoid duplicating the query
// across admin, dashboard, and internal routes.
router.get('/stats', (req, res) => {
  const totals = getOrderStats();
  const activeKeys = /** @type {any} */ (
    db.prepare(`SELECT COUNT(*) AS count FROM api_keys WHERE enabled = 1`).get()
  );
  res.json({ ...totals, active_keys: activeKeys.count });
});

// GET /admin/platform-wallet — treasury wallet public key + network.
// The owner tops up this address off-chain to fund USDC/XLM refunds.
// Balance is fetched client-side directly from Horizon so the backend
// doesn't have to touch the network on every poll.
router.get('/platform-wallet', (req, res) => {
  try {
    const { Keypair } = require('@stellar/stellar-sdk');
    const secret = process.env.STELLAR_XLM_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'stellar_secret_not_configured' });
    }
    const keypair = Keypair.fromSecret(secret);
    res.json({
      public_key: keypair.publicKey(),
      network: process.env.STELLAR_NETWORK || 'mainnet',
    });
  } catch (err) {
    res.status(500).json({ error: 'derive_failed', message: err.message });
  }
});

// GET /admin/system — system state (frozen, consecutive failures)
router.get('/system', (req, res) => {
  const rows = /** @type {any[]} */ (db.prepare(`SELECT key, value FROM system_state`).all());
  const state = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json(state);
});

// GET /admin/health — operator-critical live metrics in one place.
// Audit A-20. Intended for the system-health dashboard panel and for
// external monitoring. Joins state from a half-dozen tables so the UI
// can render without a dozen round-trips.
router.get('/health', (req, res) => {
  const systemState = Object.fromEntries(
    /** @type {any[]} */ (db.prepare(`SELECT key, value FROM system_state`).all()).map((r) => [
      r.key,
      r.value,
    ]),
  );

  // Order pipeline status distribution — the shape of the operational pipeline
  const orderStates = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT status, COUNT(*) AS count
    FROM orders
    WHERE created_at >= datetime('now', '-1 hour')
    GROUP BY status
  `,
      )
      .all()
  );

  // Watcher lag — latest ledger we've processed vs latest known Stellar ledger
  // (the latest is fetched opportunistically; if unavailable we just return
  // the cursor so operators can compare manually)
  const stellarCursor = systemState.stellar_start_ledger || null;

  // Webhook delivery health — look at recent history
  const webhookHealth = db
    .prepare(
      `
    SELECT
      SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN delivered = 0 AND attempts >= 3 THEN 1 ELSE 0 END) AS dead,
      SUM(CASE WHEN delivered = 0 AND attempts < 3 THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM webhook_queue
    WHERE created_at >= datetime('now', '-24 hours')
  `,
    )
    .get();

  // Admin action volume — recent destructive ops (last 24h)
  const recentAdminActions = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT action, COUNT(*) AS count
    FROM admin_actions
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY action
    ORDER BY count DESC
  `,
      )
      .all()
  );

  // Card retention — how many orders still hold plaintext-equivalent PAN
  const retentionState = db
    .prepare(
      `
    SELECT
      SUM(CASE WHEN card_number IS NOT NULL THEN 1 ELSE 0 END) AS holding_pan,
      SUM(CASE WHEN card_number IS NULL AND status = 'delivered' THEN 1 ELSE 0 END) AS purged
    FROM orders
  `,
    )
    .get();

  res.json({
    frozen: systemState.frozen === '1',
    consecutive_failures: parseInt(systemState.consecutive_failures || '0'),
    stellar_cursor_ledger: stellarCursor ? parseInt(stellarCursor) : null,
    orders_last_hour: Object.fromEntries(orderStates.map((r) => [r.status, r.count])),
    webhook_24h: webhookHealth,
    admin_actions_24h: recentAdminActions,
    card_retention: retentionState,
    now: new Date().toISOString(),
  });
});

// POST /admin/system/unfreeze — manually unfreeze after investigation (owner only)
router.post('/system/unfreeze', requireOwner, (req, res) => {
  db.prepare(`INSERT OR REPLACE INTO system_state (key, value) VALUES ('frozen', '0')`).run();
  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('consecutive_failures', '0')`,
  ).run();
  bizEvent('admin.system_unfrozen', { actor: req.user.email });
  recordAdminAction(req, 'system_unfreeze', 'system', null, {});
  res.json({ ok: true });
});

// Validate fields shared by create and update
function validateApiKeyFields({
  spend_limit_usdc,
  default_webhook_url,
  wallet_public_key,
  policy_daily_limit_usdc,
  policy_single_tx_limit_usdc,
  policy_require_approval_above_usdc,
  policy_allowed_hours,
  policy_allowed_days,
  mode,
  rate_limit_rpm,
  expires_at,
}) {
  if (spend_limit_usdc !== undefined && spend_limit_usdc !== null) {
    if (!/^\d+(\.\d+)?$/.test(String(spend_limit_usdc)) || parseFloat(spend_limit_usdc) <= 0) {
      return {
        error: 'invalid_spend_limit',
        message: 'spend_limit_usdc must be a positive decimal (e.g. "100.00")',
      };
    }
  }
  if (
    default_webhook_url !== undefined &&
    default_webhook_url !== null &&
    default_webhook_url !== ''
  ) {
    try {
      const u = new URL(default_webhook_url);
      if (u.protocol !== 'https:')
        return { error: 'invalid_webhook_url', message: 'default_webhook_url must use HTTPS' };
    } catch {
      return { error: 'invalid_webhook_url', message: 'default_webhook_url must be a valid URL' };
    }
  }
  if (wallet_public_key !== undefined && wallet_public_key !== null && wallet_public_key !== '') {
    if (!/^G[A-Z2-7]{55}$/.test(wallet_public_key)) {
      return {
        error: 'invalid_wallet_public_key',
        message: 'wallet_public_key must be a valid Stellar G-address (56 chars, starts with G)',
      };
    }
  }
  for (const [field, val] of [
    ['policy_daily_limit_usdc', policy_daily_limit_usdc],
    ['policy_single_tx_limit_usdc', policy_single_tx_limit_usdc],
    ['policy_require_approval_above_usdc', policy_require_approval_above_usdc],
  ]) {
    if (val !== undefined && val !== null && val !== '') {
      if (isNaN(parseFloat(val)) || parseFloat(val) < 0) {
        return { error: 'invalid_policy', message: `${field} must be a non-negative number` };
      }
    }
  }
  if (
    policy_allowed_hours !== undefined &&
    policy_allowed_hours !== null &&
    policy_allowed_hours !== ''
  ) {
    try {
      const h = JSON.parse(policy_allowed_hours);
      if (!/^\d{2}:\d{2}$/.test(h.start) || !/^\d{2}:\d{2}$/.test(h.end)) throw new Error();
    } catch {
      return {
        error: 'invalid_policy',
        message: 'policy_allowed_hours must be JSON like {"start":"09:00","end":"17:00"}',
      };
    }
  }
  if (
    policy_allowed_days !== undefined &&
    policy_allowed_days !== null &&
    policy_allowed_days !== ''
  ) {
    try {
      const d = JSON.parse(policy_allowed_days);
      if (!Array.isArray(d) || d.some((n) => n < 0 || n > 6)) throw new Error();
    } catch {
      return {
        error: 'invalid_policy',
        message: 'policy_allowed_days must be JSON array of day numbers 0–6 (e.g. [1,2,3,4,5])',
      };
    }
  }
  if (mode !== undefined && mode !== null && mode !== '') {
    if (mode !== 'live' && mode !== 'sandbox') {
      return { error: 'invalid_mode', message: 'mode must be "live" or "sandbox"' };
    }
  }
  if (rate_limit_rpm !== undefined && rate_limit_rpm !== null && rate_limit_rpm !== '') {
    const rpm = parseInt(rate_limit_rpm);
    if (isNaN(rpm) || rpm < 1 || rpm > 10000) {
      return {
        error: 'invalid_rate_limit',
        message: 'rate_limit_rpm must be an integer between 1 and 10000',
      };
    }
  }
  if (expires_at !== undefined && expires_at !== null && expires_at !== '') {
    if (isNaN(Date.parse(expires_at))) {
      return { error: 'invalid_expires_at', message: 'expires_at must be a valid ISO date string' };
    }
  }
  return null;
}

// POST /admin/api-keys — create a new agent API key (owner only)
router.post('/api-keys', requireOwner, async (req, res) => {
  const { label, spend_limit_usdc, default_webhook_url, wallet_public_key } = req.body;
  const validationErr = validateApiKeyFields(
    /** @type {any} */ ({ spend_limit_usdc, default_webhook_url, wallet_public_key }),
  );
  if (validationErr) return res.status(400).json(validationErr);
  if (default_webhook_url) {
    try {
      await assertSafeUrl(default_webhook_url);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_webhook_url', message: err.message });
    }
  }
  const id = uuidv4();
  const rawKey = `cards402_${crypto.randomBytes(24).toString('hex')}`;
  // key_prefix = first 12 hex chars of the random portion — used for O(1) auth lookup
  const keyPrefix = rawKey.slice(9, 21);
  const keyHash = await bcrypt.hash(rawKey, 10);
  // webhook_secret is plaintext — used only for HMAC signing outbound webhooks
  const webhookSecret = `whsec_${crypto.randomBytes(32).toString('hex')}`;

  db.prepare(
    `
    INSERT INTO api_keys (id, key_hash, key_prefix, label, spend_limit_usdc, webhook_secret, default_webhook_url, wallet_public_key)
    VALUES (@id, @keyHash, @keyPrefix, @label, @spend_limit_usdc, @webhook_secret, @default_webhook_url, @wallet_public_key)
  `,
  ).run({
    id,
    keyHash,
    keyPrefix,
    label: label || null,
    spend_limit_usdc: spend_limit_usdc || null,
    webhook_secret: webhookSecret,
    default_webhook_url: default_webhook_url || null,
    wallet_public_key: wallet_public_key || null,
  });

  // Return the raw key and webhook secret once — neither can be recovered after this
  res.status(201).json({
    id,
    key: rawKey,
    webhook_secret: webhookSecret,
    label,
    wallet_public_key: wallet_public_key || null,
    warning: 'Store the key and webhook_secret securely — they will not be shown again.',
  });
});

// GET /admin/api-keys — list all keys (includes policy and new fields)
router.get('/api-keys', (req, res) => {
  const { deriveAgentState } = require('../lib/agent-state');
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT id, label, spend_limit_usdc, total_spent_usdc, default_webhook_url, wallet_public_key,
           enabled, suspended, created_at, last_used_at, key_prefix,
           policy_daily_limit_usdc, policy_single_tx_limit_usdc, policy_require_approval_above_usdc,
           policy_allowed_hours, policy_allowed_days,
           mode, rate_limit_rpm, expires_at,
           agent_state, agent_state_at, agent_state_detail
    FROM api_keys
  `,
      )
      .all()
  );
  res.json(rows.map((row) => ({ ...row, agent: deriveAgentState(row) })));
});

// PATCH /admin/api-keys/:id — update limits, policy, or disable
router.patch('/api-keys/:id', async (req, res) => {
  const {
    enabled,
    spend_limit_usdc,
    default_webhook_url,
    label,
    wallet_public_key,
    policy_daily_limit_usdc,
    policy_single_tx_limit_usdc,
    policy_require_approval_above_usdc,
    policy_allowed_hours,
    policy_allowed_days,
    mode,
    rate_limit_rpm,
    expires_at,
  } = req.body;
  const validationErr = validateApiKeyFields({
    spend_limit_usdc,
    default_webhook_url,
    wallet_public_key,
    policy_daily_limit_usdc,
    policy_single_tx_limit_usdc,
    policy_require_approval_above_usdc,
    policy_allowed_hours,
    policy_allowed_days,
    mode,
    rate_limit_rpm,
    expires_at,
  });
  if (validationErr) return res.status(400).json(validationErr);
  if (default_webhook_url) {
    try {
      await assertSafeUrl(default_webhook_url);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_webhook_url', message: err.message });
    }
  }
  const fields = {};
  if (enabled !== undefined) fields.enabled = enabled ? 1 : 0;
  if (spend_limit_usdc !== undefined) fields.spend_limit_usdc = spend_limit_usdc || null;
  if (default_webhook_url !== undefined) fields.default_webhook_url = default_webhook_url || null;
  if (label !== undefined) fields.label = label || null;
  if (wallet_public_key !== undefined) fields.wallet_public_key = wallet_public_key || null;
  if (policy_daily_limit_usdc !== undefined)
    fields.policy_daily_limit_usdc = policy_daily_limit_usdc || null;
  if (policy_single_tx_limit_usdc !== undefined)
    fields.policy_single_tx_limit_usdc = policy_single_tx_limit_usdc || null;
  if (policy_require_approval_above_usdc !== undefined)
    fields.policy_require_approval_above_usdc = policy_require_approval_above_usdc || null;
  if (policy_allowed_hours !== undefined)
    fields.policy_allowed_hours = policy_allowed_hours || null;
  if (policy_allowed_days !== undefined) fields.policy_allowed_days = policy_allowed_days || null;
  if (mode !== undefined) fields.mode = mode || 'live';
  if (rate_limit_rpm !== undefined)
    fields.rate_limit_rpm = rate_limit_rpm ? parseInt(rate_limit_rpm) : null;
  if (expires_at !== undefined) fields.expires_at = expires_at || null;

  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

  // B-9: allowlist column names before interpolating into SQL to prevent injection
  const ALLOWED_COLUMNS = new Set([
    'enabled',
    'spend_limit_usdc',
    'default_webhook_url',
    'label',
    'wallet_public_key',
    'policy_daily_limit_usdc',
    'policy_single_tx_limit_usdc',
    'policy_require_approval_above_usdc',
    'policy_allowed_hours',
    'policy_allowed_days',
    'mode',
    'rate_limit_rpm',
    'expires_at',
  ]);
  for (const k of Object.keys(fields)) {
    if (!ALLOWED_COLUMNS.has(k)) return res.status(400).json({ error: 'invalid_field', field: k });
  }
  const sets = Object.keys(fields)
    .map((k) => `${k} = @${k}`)
    .join(', ');
  const result = db
    .prepare(`UPDATE api_keys SET ${sets} WHERE id = @id`)
    .run({ id: req.params.id, ...fields });

  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// GET /admin/api-keys — list all keys (now includes policy fields)
// (This overrides the earlier GET to return policy fields)

// POST /admin/api-keys/:id/rotate — generate a new secret, atomically replacing the old one
router.post('/api-keys/:id/rotate', requireOwner, async (req, res) => {
  const key = db.prepare(`SELECT id, label FROM api_keys WHERE id = ?`).get(req.params.id);
  if (!key) return res.status(404).json({ error: 'not_found' });

  const rawKey = `cards402_${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = rawKey.slice(9, 21);
  const keyHash = await bcrypt.hash(rawKey, 10);

  db.prepare(`UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE id = ?`).run(
    keyHash,
    keyPrefix,
    req.params.id,
  );
  bizEvent('admin.key_rotated', { api_key_id: req.params.id, actor: req.user.email });
  res.json({
    id: req.params.id,
    key: rawKey,
    warning: 'New secret generated — the old key is immediately invalid. Update all consumers now.',
  });
});

// POST /admin/api-keys/:id/test-webhook — fire a test event to the configured webhook URL
router.post('/api-keys/:id/test-webhook', async (req, res) => {
  const key = /** @type {any} */ (
    db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(req.params.id)
  );
  if (!key) return res.status(404).json({ error: 'not_found' });
  if (!key.default_webhook_url)
    return res.status(422).json({
      error: 'no_webhook_configured',
      message: 'Set a default_webhook_url on this key first.',
    });

  try {
    await fireWebhook(
      key.default_webhook_url,
      {
        event: 'test',
        order_id: `test-${Date.now()}`,
        status: 'test',
        message: 'Test webhook from cards402 admin.',
      },
      key.webhook_secret || null,
      null,
    );
    bizEvent('admin.webhook_test', { api_key_id: req.params.id, actor: req.user.email });
    res.json({ ok: true, url: key.default_webhook_url });
  } catch (err) {
    res.status(502).json({ error: 'webhook_failed', message: err.message });
  }
});

// GET /admin/api-keys/:id/activity — 7-day daily order counts for sparkline
router.get('/api-keys/:id/activity', (req, res) => {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT date(created_at) AS day, COUNT(*) AS count
    FROM orders
    WHERE api_key_id = ? AND date(created_at) >= date('now', '-6 days')
    GROUP BY day
    ORDER BY day ASC
  `,
      )
      .all(req.params.id)
  );

  // Fill in missing days with 0
  const result = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    const day = date.toISOString().slice(0, 10);
    const found = rows.find((r) => r.day === day);
    result.push({ day, count: found ? found.count : 0 });
  }
  res.json(result);
});

// POST /admin/api-keys/:id/suspend — immediately suspend an agent (owner only)
router.post('/api-keys/:id/suspend', requireOwner, (req, res) => {
  const result = db.prepare(`UPDATE api_keys SET suspended = 1 WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  // Cancel all pending approvals for this agent
  const pendingApprovals = /** @type {any[]} */ (
    db
      .prepare(`SELECT * FROM approval_requests WHERE api_key_id = ? AND status = 'pending'`)
      .all(req.params.id)
  );
  for (const approval of pendingApprovals) {
    db.prepare(
      `UPDATE approval_requests SET status = 'rejected', decided_at = ?, decision_note = ? WHERE id = ?`,
    ).run(now, 'Agent suspended by owner', approval.id);
    db.prepare(`UPDATE orders SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?`).run(
      'Agent suspended by owner',
      now,
      approval.order_id,
    );
    recordDecision(
      req.params.id,
      approval.order_id,
      approval.amount_usdc,
      'blocked',
      'suspended',
      'Agent suspended by owner',
    );
  }
  bizEvent('admin.agent_suspended', {
    api_key_id: req.params.id,
    actor: req.user.email,
    cancelled_approvals: pendingApprovals.length,
  });
  recordAdminAction(req, 'suspend_api_key', 'api_key', req.params.id, {
    cancelled_approvals: pendingApprovals.length,
  });
  res.json({ ok: true });
});

// POST /admin/api-keys/:id/unsuspend — lift suspension (owner only)
router.post('/api-keys/:id/unsuspend', requireOwner, (req, res) => {
  const result = db.prepare(`UPDATE api_keys SET suspended = 0 WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  bizEvent('admin.agent_unsuspended', { api_key_id: req.params.id, actor: req.user.email });
  recordAdminAction(req, 'unsuspend_api_key', 'api_key', req.params.id, {});
  res.json({ ok: true });
});

// ── Approval requests ─────────────────────────────────────────────────────────

// GET /admin/approval-requests — list approvals (default: pending only)
router.get('/approval-requests', (req, res) => {
  const { status = 'pending', limit = 100 } = req.query;
  const rows = db
    .prepare(
      `
    SELECT ar.id, ar.api_key_id, ar.order_id, ar.amount_usdc, ar.agent_note,
           ar.status, ar.requested_at, ar.expires_at, ar.decided_at, ar.decided_by, ar.decision_note,
           k.label AS api_key_label
    FROM approval_requests ar
    LEFT JOIN api_keys k ON ar.api_key_id = k.id
    WHERE ar.status = ?
    ORDER BY ar.requested_at DESC
    LIMIT ?
  `,
    )
    .all(status, parseInt(String(limit)) || 100);
  res.json(rows);
});

// POST /admin/approval-requests/:id/approve
router.post('/approval-requests/:id/approve', async (req, res) => {
  const approval = /** @type {any} */ (
    db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(req.params.id)
  );
  if (!approval) return res.status(404).json({ error: 'not_found' });
  if (approval.status !== 'pending')
    return res.status(409).json({ error: 'already_decided', current_status: approval.status });
  // B-4: reject expired approvals — avoids dispatching a card after the approval window closed
  if (new Date(approval.expires_at) <= new Date())
    return res.status(410).json({ error: 'approval_expired' });

  // Build Soroban contract payment instructions — agent pays the contract directly.
  let xlmAmount = null;
  try {
    xlmAmount = await usdToXlm(approval.amount_usdc);
  } catch (err) {
    console.warn(`[admin] XLM price lookup failed for approval ${req.params.id}: ${err.message}`);
  }

  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const contractPayment = {
    type: 'soroban_contract',
    contract_id: process.env.RECEIVER_CONTRACT_ID,
    order_id: approval.order_id,
    usdc: { amount: String(approval.amount_usdc), asset: `USDC:${USDC_ISSUER}` },
    ...(xlmAmount && { xlm: { amount: xlmAmount } }),
  };

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE approval_requests SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?`,
  ).run(now, req.user.email, req.body.note || null, req.params.id);

  // Transition order to pending_payment with Soroban contract payment instructions.
  db.prepare(
    `
    UPDATE orders
    SET status = 'pending_payment',
        vcc_payment_json = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(JSON.stringify(contractPayment), now, approval.order_id);

  recordDecision(
    approval.api_key_id,
    approval.order_id,
    approval.amount_usdc,
    'approved',
    'owner_approved',
    req.body.note || 'Approved by account owner',
  );

  // Notify agent via webhook if configured
  const order = /** @type {any} */ (
    db.prepare(`SELECT * FROM orders WHERE id = ?`).get(approval.order_id)
  );
  const keyRow = /** @type {any} */ (
    db
      .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
      .get(approval.api_key_id)
  );
  const webhookUrl = order?.webhook_url || keyRow?.default_webhook_url || null;
  if (webhookUrl) {
    enqueueWebhook(
      webhookUrl,
      {
        order_id: approval.order_id,
        status: 'pending_payment',
        phase: 'awaiting_payment',
        note: 'Transaction approved by owner.',
      },
      keyRow?.webhook_secret || null,
    ).catch(() => {});
  }

  bizEvent('admin.approval_approved', {
    approval_id: req.params.id,
    order_id: approval.order_id,
    actor: req.user.email,
  });
  recordAdminAction(req, 'approve_order', 'order', approval.order_id, {
    approval_id: req.params.id,
    amount_usdc: approval.amount_usdc,
    note: req.body.note || null,
  });
  res.json({ ok: true });
});

// POST /admin/approval-requests/:id/reject
router.post('/approval-requests/:id/reject', (req, res) => {
  const approval = /** @type {any} */ (
    db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(req.params.id)
  );
  if (!approval) return res.status(404).json({ error: 'not_found' });
  if (approval.status !== 'pending')
    return res.status(409).json({ error: 'already_decided', current_status: approval.status });
  if (new Date(approval.expires_at) <= new Date())
    return res.status(410).json({ error: 'approval_expired' });

  const now = new Date().toISOString();
  const note = req.body.note || 'Rejected by account owner';
  db.prepare(
    `UPDATE approval_requests SET status = 'rejected', decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?`,
  ).run(now, req.user.email, note, req.params.id);
  db.prepare(`UPDATE orders SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?`).run(
    note,
    now,
    approval.order_id,
  );

  recordDecision(
    approval.api_key_id,
    approval.order_id,
    approval.amount_usdc,
    'blocked',
    'owner_rejected',
    note,
  );

  // Notify agent via webhook
  const order = /** @type {any} */ (
    db.prepare(`SELECT * FROM orders WHERE id = ?`).get(approval.order_id)
  );
  const keyRow = /** @type {any} */ (
    db
      .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
      .get(approval.api_key_id)
  );
  const webhookUrl = order?.webhook_url || keyRow?.default_webhook_url || null;
  if (webhookUrl) {
    enqueueWebhook(
      webhookUrl,
      { order_id: approval.order_id, status: 'rejected', phase: 'rejected', error: note },
      keyRow?.webhook_secret || null,
    ).catch(() => {});
  }

  bizEvent('admin.approval_rejected', {
    approval_id: req.params.id,
    order_id: approval.order_id,
    actor: req.user.email,
  });
  recordAdminAction(req, 'reject_order', 'order', approval.order_id, {
    approval_id: req.params.id,
    amount_usdc: approval.amount_usdc,
    note,
  });
  res.json({ ok: true });
});

// ── Admin action audit log ────────────────────────────────────────────────────

// GET /admin/admin-actions — timeline of destructive operator actions.
// Optional filters: actor_email, action, target_type, from/to date.
// Audit A-17.
router.get('/admin-actions', (req, res) => {
  const {
    actor_email,
    action,
    target_type,
    target_id,
    from,
    to,
    limit = 200,
    offset = 0,
  } = req.query;
  let query = `
    SELECT id, actor_email, action, target_type, target_id, metadata, ip, request_id, created_at
    FROM admin_actions WHERE 1=1
  `;
  const params = [];
  if (actor_email) {
    query += ` AND actor_email = ?`;
    params.push(actor_email);
  }
  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }
  if (target_type) {
    query += ` AND target_type = ?`;
    params.push(target_type);
  }
  if (target_id) {
    query += ` AND target_id = ?`;
    params.push(target_id);
  }
  if (from) {
    query += ` AND date(created_at) >= ?`;
    params.push(from);
  }
  if (to) {
    query += ` AND date(created_at) <= ?`;
    params.push(to);
  }
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(parseInt(String(limit)) || 200, 1000));
  params.push(Math.max(parseInt(String(offset)) || 0, 0));

  const rows = /** @type {any[]} */ (db.prepare(query).all(...params)).map((r) => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : {},
  }));
  res.json(rows);
});

// ── Policy audit log ──────────────────────────────────────────────────────────

// GET /admin/policy-decisions — audit log, optionally as CSV
router.get('/policy-decisions', (req, res) => {
  const { api_key_id, decision, limit = 500, format } = req.query;
  let query = `
    SELECT pd.id, pd.api_key_id, pd.order_id, pd.decision, pd.rule, pd.reason,
           pd.amount_usdc, pd.created_at, k.label AS api_key_label
    FROM policy_decisions pd
    LEFT JOIN api_keys k ON pd.api_key_id = k.id
    WHERE 1=1
  `;
  const params = [];
  if (api_key_id) {
    query += ` AND pd.api_key_id = ?`;
    params.push(api_key_id);
  }
  if (decision) {
    query += ` AND pd.decision = ?`;
    params.push(decision);
  }
  query += ` ORDER BY pd.created_at DESC LIMIT ?`;
  params.push(Math.min(parseInt(String(limit)) || 500, 2000));

  const rows = /** @type {any[]} */ (db.prepare(query).all(...params));

  if (format === 'csv') {
    const cols = [
      'id',
      'created_at',
      'api_key_label',
      'api_key_id',
      'decision',
      'rule',
      'amount_usdc',
      'reason',
      'order_id',
    ];
    const escape = (v) =>
      v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="policy-audit-${Date.now()}.csv"`);
    return res.send(lines.join('\n'));
  }

  res.json(rows);
});

// GET /admin/webhooks — recent webhook queue entries (delivered + pending + failed)
router.get('/webhooks', (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, url, attempts, next_attempt, last_error, delivered, created_at
    FROM webhook_queue
    ORDER BY created_at DESC
    LIMIT 100
  `,
    )
    .all();
  res.json(rows);
});

// POST /admin/webhooks/:id/retry — immediately retry a failed webhook delivery
router.post('/webhooks/:id/retry', async (req, res) => {
  const row = /** @type {any} */ (
    db.prepare(`SELECT * FROM webhook_queue WHERE id = ?`).get(req.params.id)
  );
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.delivered) return res.status(409).json({ error: 'already_delivered' });

  try {
    await fireWebhook(row.url, JSON.parse(row.payload), row.secret, null);
    db.prepare(`UPDATE webhook_queue SET delivered = 1 WHERE id = ?`).run(row.id);
    bizEvent('admin.webhook_retry_ok', { webhook_id: row.id, actor: req.user.email });
    res.json({ ok: true });
  } catch (err) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE webhook_queue SET attempts = attempts + 1, last_error = ?, next_attempt = ? WHERE id = ?`,
    ).run(err.message, now, row.id);
    res.status(502).json({ error: 'delivery_failed', message: err.message });
  }
});

// GET /admin/unmatched-payments — payments that arrived but couldn't be matched to an order
router.get('/unmatched-payments', (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT id, stellar_txid, sender_address, payment_asset, amount_usdc, amount_xlm,
           claimed_order_id, reason, refund_stellar_txid, created_at
    FROM unmatched_payments
    ORDER BY created_at DESC
    LIMIT 200
  `,
    )
    .all();
  res.json(rows);
});

// POST /admin/orders/:id/refund — manually trigger refund (owner only)
router.post('/orders/:id/refund', requireOwner, async (req, res) => {
  const order = /** @type {any} */ (
    db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id)
  );
  if (!order) return res.status(404).json({ error: 'not_found' });
  bizEvent('admin.manual_refund', {
    order_id: order.id,
    status: order.status,
    actor: req.user.email,
  });
  recordAdminAction(req, 'refund_order', 'order', order.id, {
    prior_status: order.status,
    amount_usdc: order.amount_usdc,
  });
  // scheduleRefund handles status transitions and the actual on-chain send
  scheduleRefund(order.id).catch((err) =>
    bizEvent('admin.refund_error', { order_id: order.id, error: err.message }),
  );
  res.json({ ok: true });
});

// ── User management ───────────────────────────────────────────────────────────

// GET /admin/users — list all users on this instance
router.get('/users', (req, res) => {
  const users = db
    .prepare(
      `
    SELECT id, email, role, created_at, last_login_at FROM users ORDER BY created_at ASC
  `,
    )
    .all();
  res.json(users);
});

// DELETE /admin/users/:id — remove a user (owner only; can't remove the owner or yourself)
router.delete('/users/:id', requireOwner, (req, res) => {
  const target = /** @type {any} */ (
    db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id)
  );
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'owner')
    return res
      .status(403)
      .json({ error: 'cannot_remove_owner', message: 'Transfer ownership first.' });
  if (target.id === req.user.id) return res.status(403).json({ error: 'cannot_remove_self' });
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(target.id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(target.id);
  res.json({ ok: true });
});

// POST /admin/users/:id/transfer-ownership — owner only; demotes self, promotes target
router.post('/users/:id/transfer-ownership', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
  const target = /** @type {any} */ (
    db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id)
  );
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'already_owner' });
  db.prepare(`UPDATE users SET role = 'user'  WHERE id = ?`).run(req.user.id);
  db.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(target.id);
  res.json({ ok: true });
});

module.exports = router;
