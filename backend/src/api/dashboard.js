// @ts-check
// Dashboard API — per-user (per-tenant) routes.
// All routes are scoped to the authenticated user's dashboard.
// Any logged-in user can access these; data is filtered by their dashboard_id.

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
/** @type {any} */ const db = require('../db');
const { enqueueWebhook } = require('../fulfillment');
const { assertSafeUrl } = require('../lib/ssrf');
const { recordDecision } = require('../policy');
const { usdToXlm } = require('../payments/xlm-price');
const requireAuth = require('../middleware/requireAuth');
const requireDashboard = require('../middleware/requireDashboard');
const { event: bizEvent } = require('../lib/logger');

const router = Router();

router.use(requireAuth, requireDashboard);

// ── Dashboard info ────────────────────────────────────────────────────────────

// GET /dashboard — dashboard info + live stats
router.get('/', (req, res) => {
  const d = req.dashboard;

  const stats = db
    .prepare(
      `
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CAST(o.amount_usdc AS REAL)), 0) AS total_gmv,
      SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN o.status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN o.status = 'pending_payment' THEN 1 ELSE 0 END) AS pending
    FROM orders o
    JOIN api_keys k ON o.api_key_id = k.id
    WHERE k.dashboard_id = ?
  `,
    )
    .get(d.id);

  const activeKeys = db
    .prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE dashboard_id = ? AND enabled = 1 AND suspended = 0`,
    )
    .get(d.id).n;

  const pendingApprovals = db
    .prepare(
      `
    SELECT COUNT(*) AS n FROM approval_requests ar
    JOIN api_keys k ON ar.api_key_id = k.id
    WHERE k.dashboard_id = ? AND ar.status = 'pending'
  `,
    )
    .get(d.id).n;

  res.json({
    id: d.id,
    name: d.name,
    spend_limit_usdc: d.spend_limit_usdc,
    frozen: d.frozen === 1,
    created_at: d.created_at,
    stats: { ...stats, active_keys: activeKeys, pending_approvals: pendingApprovals },
  });
});

// GET /dashboard/stats
router.get('/stats', (req, res) => {
  const totals = db
    .prepare(
      `
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CAST(o.amount_usdc AS REAL)), 0) AS total_gmv,
      SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN o.status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN o.status = 'pending_payment' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN o.status = 'refund_pending' THEN 1 ELSE 0 END) AS refund_pending
    FROM orders o
    JOIN api_keys k ON o.api_key_id = k.id
    WHERE k.dashboard_id = ?
  `,
    )
    .get(req.dashboard.id);

  const activeKeys = db
    .prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE dashboard_id = ? AND enabled = 1`)
    .get(req.dashboard.id).n;

  res.json({ ...totals, active_keys: activeKeys });
});

// ── Orders ────────────────────────────────────────────────────────────────────

// GET /dashboard/orders
router.get('/orders', (req, res) => {
  const { status, limit = 50, api_key_id } = /** @type {Record<string, any>} */ (req.query);
  let query = `
    SELECT o.id, o.status, o.amount_usdc, o.payment_asset, o.stellar_txid,
           o.card_brand, o.error, o.created_at, o.updated_at,
           k.label AS api_key_label
    FROM orders o
    JOIN api_keys k ON o.api_key_id = k.id
    WHERE k.dashboard_id = ?
  `;
  const params = [req.dashboard.id];
  if (status) {
    query += ` AND o.status = ?`;
    params.push(String(status));
  }
  if (api_key_id) {
    // Verify api_key_id belongs to this dashboard
    const owns = db
      .prepare(`SELECT 1 FROM api_keys WHERE id = ? AND dashboard_id = ?`)
      .get(String(api_key_id), req.dashboard.id);
    if (!owns) return res.status(403).json({ error: 'forbidden' });
    query += ` AND o.api_key_id = ?`;
    params.push(String(api_key_id));
  }
  query += ` ORDER BY o.created_at DESC LIMIT ?`;
  params.push(/** @type {any} */ (Math.min(parseInt(String(limit)) || 50, 500)));
  res.json(db.prepare(query).all(...params));
});

// ── API Keys ──────────────────────────────────────────────────────────────────

function validateApiKeyFields({
  spend_limit_usdc,
  default_webhook_url,
  wallet_public_key,
  policy_daily_limit_usdc,
  policy_single_tx_limit_usdc,
  policy_require_approval_above_usdc,
  policy_allowed_hours,
  policy_allowed_days,
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
  return null;
}

// GET /dashboard/api-keys
router.get('/api-keys', (req, res) => {
  res.json(
    db
      .prepare(
        `
    SELECT id, label, spend_limit_usdc, total_spent_usdc, default_webhook_url, wallet_public_key,
           enabled, suspended, last_used_at, created_at,
           policy_daily_limit_usdc, policy_single_tx_limit_usdc,
           policy_require_approval_above_usdc, policy_allowed_hours, policy_allowed_days,
           mode, rate_limit_rpm, expires_at
    FROM api_keys WHERE dashboard_id = ? ORDER BY created_at DESC
  `,
      )
      .all(req.dashboard.id),
  );
});

// POST /dashboard/api-keys — create a new agent API key
router.post('/api-keys', async (req, res) => {
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
  const keyPrefix = rawKey.slice(9, 21);
  const keyHash = await bcrypt.hash(rawKey, 10);
  const webhookSecret = `whsec_${crypto.randomBytes(32).toString('hex')}`;

  db.prepare(
    `
    INSERT INTO api_keys
      (id, key_hash, key_prefix, label, spend_limit_usdc, webhook_secret,
       default_webhook_url, wallet_public_key, dashboard_id)
    VALUES
      (@id, @keyHash, @keyPrefix, @label, @spend_limit_usdc, @webhookSecret,
       @default_webhook_url, @wallet_public_key, @dashboard_id)
  `,
  ).run({
    id,
    keyHash,
    keyPrefix,
    label: label || null,
    spend_limit_usdc: spend_limit_usdc || null,
    webhookSecret,
    default_webhook_url: default_webhook_url || null,
    wallet_public_key: wallet_public_key || null,
    dashboard_id: req.dashboard.id,
  });

  bizEvent('dashboard.key_created', {
    dashboard_id: req.dashboard.id,
    api_key_id: id,
    actor: req.user.email,
  });

  res.status(201).json({
    id,
    key: rawKey,
    webhook_secret: webhookSecret,
    label: label || null,
    wallet_public_key: wallet_public_key || null,
    warning: 'Store the key and webhook_secret securely — they will not be shown again.',
  });
});

// PATCH /dashboard/api-keys/:id — update limits/policy
router.patch('/api-keys/:id', async (req, res) => {
  const owned = db
    .prepare(`SELECT id FROM api_keys WHERE id = ? AND dashboard_id = ?`)
    .get(req.params.id, req.dashboard.id);
  if (!owned) return res.status(404).json({ error: 'not_found' });

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

  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'nothing_to_update' });

  // Allowlist column names before interpolating into SQL to prevent injection
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
  ]);
  for (const k of Object.keys(fields)) {
    if (!ALLOWED_COLUMNS.has(k)) return res.status(400).json({ error: 'invalid_field', field: k });
  }

  const sets = Object.keys(fields)
    .map((k) => `${k} = @${k}`)
    .join(', ');
  db.prepare(`UPDATE api_keys SET ${sets} WHERE id = @id AND dashboard_id = @dashboard_id`).run({
    id: req.params.id,
    dashboard_id: req.dashboard.id,
    ...fields,
  });

  res.json({ ok: true });
});

// DELETE /dashboard/api-keys/:id
router.delete('/api-keys/:id', (req, res) => {
  const result = db
    .prepare(`DELETE FROM api_keys WHERE id = ? AND dashboard_id = ?`)
    .run(req.params.id, req.dashboard.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  bizEvent('dashboard.key_deleted', {
    dashboard_id: req.dashboard.id,
    api_key_id: req.params.id,
    actor: req.user.email,
  });
  res.json({ ok: true });
});

// POST /dashboard/api-keys/:id/suspend
router.post('/api-keys/:id/suspend', (req, res) => {
  const result = db
    .prepare(`UPDATE api_keys SET suspended = 1 WHERE id = ? AND dashboard_id = ?`)
    .run(req.params.id, req.dashboard.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });

  const now = new Date().toISOString();
  const pendingApprovals = db
    .prepare(`SELECT * FROM approval_requests WHERE api_key_id = ? AND status = 'pending'`)
    .all(req.params.id);
  for (const approval of pendingApprovals) {
    db.prepare(
      `UPDATE approval_requests SET status = 'rejected', decided_at = ?, decision_note = ? WHERE id = ?`,
    ).run(now, 'Agent suspended', approval.id);
    db.prepare(`UPDATE orders SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?`).run(
      'Agent suspended',
      now,
      approval.order_id,
    );
    recordDecision(
      req.params.id,
      approval.order_id,
      approval.amount_usdc,
      'blocked',
      'suspended',
      'Agent suspended',
    );
  }
  bizEvent('dashboard.agent_suspended', {
    dashboard_id: req.dashboard.id,
    api_key_id: req.params.id,
    actor: req.user.email,
  });
  res.json({ ok: true });
});

// POST /dashboard/api-keys/:id/unsuspend
router.post('/api-keys/:id/unsuspend', (req, res) => {
  const result = db
    .prepare(`UPDATE api_keys SET suspended = 0 WHERE id = ? AND dashboard_id = ?`)
    .run(req.params.id, req.dashboard.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  bizEvent('dashboard.agent_unsuspended', {
    dashboard_id: req.dashboard.id,
    api_key_id: req.params.id,
    actor: req.user.email,
  });
  res.json({ ok: true });
});

// ── Approval requests ─────────────────────────────────────────────────────────

// GET /dashboard/approval-requests
router.get('/approval-requests', (req, res) => {
  const { status = 'pending', limit = 100 } = /** @type {Record<string, any>} */ (req.query);
  const rows = db
    .prepare(
      `
    SELECT ar.id, ar.api_key_id, ar.order_id, ar.amount_usdc, ar.agent_note,
           ar.status, ar.requested_at, ar.expires_at, ar.decided_at, ar.decision_note,
           k.label AS api_key_label
    FROM approval_requests ar
    JOIN api_keys k ON ar.api_key_id = k.id
    WHERE k.dashboard_id = ? AND ar.status = ?
    ORDER BY ar.requested_at DESC
    LIMIT ?
  `,
    )
    .all(req.dashboard.id, String(status), Math.min(parseInt(String(limit)) || 100, 500));
  res.json(rows);
});

// POST /dashboard/approval-requests/:id/approve
router.post('/approval-requests/:id/approve', async (req, res) => {
  const approval = db
    .prepare(
      `
    SELECT ar.* FROM approval_requests ar
    JOIN api_keys k ON ar.api_key_id = k.id
    WHERE ar.id = ? AND k.dashboard_id = ?
  `,
    )
    .get(req.params.id, req.dashboard.id);
  if (!approval) return res.status(404).json({ error: 'not_found' });
  if (approval.status !== 'pending')
    return res.status(409).json({ error: 'already_decided', current_status: approval.status });
  // B-4: reject expired approvals — avoids dispatching a card after the approval window closed
  if (new Date(approval.expires_at) <= new Date())
    return res.status(410).json({ error: 'approval_expired' });

  // Build the Soroban receiver-contract payment instructions for the agent.
  // VCC is not contacted until the Soroban watcher sees the agent's payment —
  // so there's no vccJobId yet; that's assigned later in index.js handlePayment.
  let xlmAmount = null;
  try {
    xlmAmount = await usdToXlm(String(approval.amount_usdc));
  } catch (err) {
    console.warn(`[dashboard] XLM price lookup failed: ${err.message}`);
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
    req.body.note || 'Approved by dashboard owner',
  );

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(approval.order_id);
  const keyRow = db
    .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
    .get(approval.api_key_id);
  const webhookUrl = order?.webhook_url || keyRow?.default_webhook_url || null;
  if (webhookUrl) {
    enqueueWebhook(
      webhookUrl,
      {
        order_id: approval.order_id,
        status: 'pending_payment',
        phase: 'awaiting_payment',
        note: 'Approved.',
      },
      keyRow?.webhook_secret || null,
    ).catch(() => {});
  }
  res.json({ ok: true });
});

// POST /dashboard/approval-requests/:id/reject
router.post('/approval-requests/:id/reject', (req, res) => {
  const approval = db
    .prepare(
      `
    SELECT ar.* FROM approval_requests ar
    JOIN api_keys k ON ar.api_key_id = k.id
    WHERE ar.id = ? AND k.dashboard_id = ?
  `,
    )
    .get(req.params.id, req.dashboard.id);
  if (!approval) return res.status(404).json({ error: 'not_found' });
  if (approval.status !== 'pending')
    return res.status(409).json({ error: 'already_decided', current_status: approval.status });

  const now = new Date().toISOString();
  const note = req.body.note || 'Rejected';
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

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(approval.order_id);
  const keyRow = db
    .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
    .get(approval.api_key_id);
  const webhookUrl = order?.webhook_url || keyRow?.default_webhook_url || null;
  if (webhookUrl) {
    enqueueWebhook(
      webhookUrl,
      { order_id: approval.order_id, status: 'rejected', phase: 'rejected', error: note },
      keyRow?.webhook_secret || null,
    ).catch(() => {});
  }
  res.json({ ok: true });
});

// ── Policy audit log ──────────────────────────────────────────────────────────

// GET /dashboard/policy-decisions
router.get('/policy-decisions', (req, res) => {
  const { api_key_id, decision, limit = 200 } = /** @type {Record<string, any>} */ (req.query);
  let query = `
    SELECT pd.id, pd.api_key_id, pd.order_id, pd.decision, pd.rule, pd.reason,
           pd.amount_usdc, pd.created_at, k.label AS api_key_label
    FROM policy_decisions pd
    JOIN api_keys k ON pd.api_key_id = k.id
    WHERE k.dashboard_id = ?
  `;
  const params = [req.dashboard.id];
  if (api_key_id) {
    query += ` AND pd.api_key_id = ?`;
    params.push(String(api_key_id));
  }
  if (decision) {
    query += ` AND pd.decision = ?`;
    params.push(String(decision));
  }
  query += ` ORDER BY pd.created_at DESC LIMIT ?`;
  params.push(/** @type {any} */ (Math.min(parseInt(String(limit)) || 200, 1000)));
  res.json(db.prepare(query).all(...params));
});

module.exports = router;
