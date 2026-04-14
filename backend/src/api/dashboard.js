// @ts-check
// Dashboard API — per-user (per-tenant) routes.
// All routes are scoped to the authenticated user's dashboard.
// Any logged-in user can access these; data is filtered by their dashboard_id.

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
/** @type {any} */ const db = require('../db');
const { enqueueWebhook, fireWebhook: fireWebhookRaw } = require('../fulfillment');
const { assertSafeUrl } = require('../lib/ssrf');
const { recordDecision } = require('../policy');
const { usdToXlm } = require('../payments/xlm-price');
const requireAuth = require('../middleware/requireAuth');
const requireDashboard = require('../middleware/requireDashboard');
const { event: bizEvent } = require('../lib/logger');
const { requirePermission } = require('../lib/permissions');
const requirePlatformOwner = require('../middleware/requirePlatformOwner');
const { recordAuditFromReq, listAudit } = require('../lib/audit');
const alerts = require('../lib/alerts');
const enabledMerchants = require('../lib/enabled-merchants');
const webhookLog = require('../lib/webhook-log');

const router = Router();

router.use(requireAuth, requireDashboard);

// Short-string sanitiser for user-supplied note/label fields. Three jobs:
//   1. Reject anything that isn't a string — an array or object would
//      otherwise coerce to "a,b" or "[object Object]" on stringify and
//      slip past downstream length checks.
//   2. Cap length so a caller can't POST a multi-MB note and balloon
//      every subsequent SELECT of the table.
//   3. Collapse empty strings to null so `""` can't silently overwrite
//      a previously-set value.
// Returns null if the input is unusable — callers pass this straight
// through to DB parameters expecting a nullable TEXT column.
function shortString(value, max) {
  if (typeof value !== 'string') return null;
  if (value.length === 0) return null;
  return value.slice(0, max);
}

// ── Live SSE feed ─────────────────────────────────────────────────────────────

// GET /dashboard/stream — Server-Sent Events feed of state changes
// scoped to this user's dashboard. Pushes every agent_state / order /
// approval transition that involves one of the user's api_keys, plus a
// coarse 'refresh' ping when business events unrelated to a specific
// key happen (system freeze, key lifecycle). Clients should refetch
// their full state on 'refresh' and patch on the typed events.
router.get('/stream', (req, res) => {
  const { subscribe } = require('../lib/event-bus');
  const { tryAcquireStreamSlot, releaseStreamSlot } = require('./orders');
  const dashboardId = req.dashboard.id;

  // Concurrent-stream cap — see the matching comment in orders.js.
  // The stream slot is keyed by dashboard id here (not api key) so
  // the dashboard and agent ceilings count independently.
  const slotKey = `dashboard:${dashboardId}`;
  const slot = tryAcquireStreamSlot(slotKey);
  if (!slot.ok) {
    return res.status(429).json({
      error: 'too_many_streams',
      reason: slot.reason,
      message: 'This dashboard has too many concurrent SSE streams open.',
    });
  }

  // Pre-load the set of api_key_ids this dashboard owns so we can
  // filter events cheaply. Re-read on each event would hammer the DB
  // under fanout.
  const keyRows = /** @type {any[]} */ (
    db.prepare(`SELECT id FROM api_keys WHERE dashboard_id = ?`).all(dashboardId)
  );
  const ownedKeys = new Set(keyRows.map((r) => r.id));

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
    // First check: a new key was just created for this dashboard. Grow the
    // ownedKeys set on the fly so subsequent agent_state events for that
    // key aren't dropped by the filter below. The createAgent handler in
    // this file emits bizEvent('dashboard.key_created', { dashboard_id,
    // api_key_id, actor }) which goes through the bus as
    // { type: 'biz', name: 'dashboard.key_created', fields: { ... } }.
    //
    // Without this enrichment, the live setup stepper only updated when
    // the 60s client-side safety-net poll fired — every typed event for
    // the newly-minted key got filtered out at the SSE boundary.
    if (
      evt.type === 'biz' &&
      evt.name === 'dashboard.key_created' &&
      evt.fields?.dashboard_id === dashboardId
    ) {
      if (evt.fields.api_key_id) ownedKeys.add(evt.fields.api_key_id);
      send('refresh', { reason: 'key_created' });
      return;
    }

    // Standard filter — only forward events about keys this dashboard owns.
    // Events with no api_key_id (system, frozen, etc.) pass through to all
    // dashboards; that's the broadcast channel for global state changes.
    const keyId = evt.api_key_id ?? evt.fields?.api_key_id;
    if (keyId && !ownedKeys.has(keyId)) return;
    send(evt.type, evt);
  });

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  let closed = false;
  req.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    releaseStreamSlot(slotKey);
  });
});

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
  const { normalizeCardBrand } = require('../lib/normalize-card');
  const { status, limit = 50, api_key_id } = /** @type {Record<string, any>} */ (req.query);
  let query = `
    SELECT o.id, o.status, o.amount_usdc, o.payment_asset, o.stellar_txid,
           o.card_brand, o.error, o.created_at, o.updated_at,
           o.api_key_id, k.label AS api_key_label
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
  const rows = /** @type {any[]} */ (db.prepare(query).all(...params));
  // Normalize the upstream catalog string before it reaches a human
  // surface. The DB intentionally keeps the raw value for ops forensics
  // (per vcc-callback.js), but dashboard consumers should always see
  // the stable label — otherwise old rows render "Visa® Reward Card,
  // 6-Month Expiration [ITNL] eGift Card" in the UI.
  for (const row of rows) {
    row.card_brand = normalizeCardBrand(row.card_brand);
  }
  res.json(rows);
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
router.get('/api-keys', requirePermission('agent:read'), (req, res) => {
  const { deriveAgentState } = require('../lib/agent-state');
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT id, label, spend_limit_usdc, total_spent_usdc, default_webhook_url, wallet_public_key,
           enabled, suspended, last_used_at, created_at,
           policy_daily_limit_usdc, policy_single_tx_limit_usdc,
           policy_require_approval_above_usdc, policy_allowed_hours, policy_allowed_days,
           mode, rate_limit_rpm, expires_at,
           agent_state, agent_state_at, agent_state_detail
    FROM api_keys WHERE dashboard_id = ? ORDER BY created_at DESC
  `,
      )
      .all(req.dashboard.id)
  );
  res.json(rows.map((row) => ({ ...row, agent: deriveAgentState(row) })));
});

// POST /dashboard/api-keys — create a new agent API key
router.post('/api-keys', requirePermission('agent:create'), async (req, res) => {
  const { spend_limit_usdc, default_webhook_url, wallet_public_key } = req.body;
  // Labels are cosmetic — 100 chars is more than enough for any real
  // agent name, and the cap stops a caller from stuffing the column
  // with a multi-MB blob that then rides along in every dashboard read.
  const label = shortString(req.body.label, 100);
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

  // Mint a one-time claim code for the agent-facing onboarding flow.
  // The agent runs `npx cards402 onboard --claim <code>` and the CLI
  // trades the code for the real api_key via POST /v1/agent/claim —
  // so the raw api_key never has to live in a pasted snippet (or the
  // agent's conversation transcript).
  const claimId = uuidv4();
  const claimCode = `c402_${crypto.randomBytes(24).toString('hex')}`;
  const claimTtlMs = 10 * 60 * 1000; // 10 min — long enough to paste + run, short enough to matter
  const claimExpiresAt = new Date(Date.now() + claimTtlMs).toISOString();
  const secretBox = require('../lib/secret-box');
  const sealedPayload = secretBox.seal(
    JSON.stringify({ api_key: rawKey, webhook_secret: webhookSecret }),
  );
  db.prepare(
    `
    INSERT INTO agent_claims (id, code, api_key_id, sealed_payload, expires_at)
    VALUES (@id, @code, @api_key_id, @sealed_payload, @expires_at)
  `,
  ).run({
    id: claimId,
    code: claimCode,
    api_key_id: id,
    sealed_payload: sealedPayload,
    expires_at: claimExpiresAt,
  });

  bizEvent('dashboard.key_created', {
    dashboard_id: req.dashboard.id,
    api_key_id: id,
    actor: req.user.email,
  });
  recordAuditFromReq(req, 'agent.create', {
    resourceType: 'agent',
    resourceId: id,
    details: { label: label || null },
  });

  res.status(201).json({
    id,
    key: rawKey,
    webhook_secret: webhookSecret,
    label: label || null,
    wallet_public_key: wallet_public_key || null,
    claim: {
      code: claimCode,
      expires_at: claimExpiresAt,
      ttl_ms: claimTtlMs,
    },
    warning: 'Store the key and webhook_secret securely — they will not be shown again.',
  });
});

// PATCH /dashboard/api-keys/:id — update limits/policy
router.patch('/api-keys/:id', requirePermission('agent:update'), async (req, res) => {
  const owned = db
    .prepare(`SELECT id FROM api_keys WHERE id = ? AND dashboard_id = ?`)
    .get(req.params.id, req.dashboard.id);
  if (!owned) return res.status(404).json({ error: 'not_found' });

  const {
    enabled,
    spend_limit_usdc,
    default_webhook_url,
    wallet_public_key,
    policy_daily_limit_usdc,
    policy_single_tx_limit_usdc,
    policy_require_approval_above_usdc,
    policy_allowed_hours,
    policy_allowed_days,
  } = req.body;
  // Only sanitise label if the caller actually sent it — `undefined`
  // means "don't touch this field" and must pass through unchanged so
  // the later `if (label !== undefined)` guard still fires.
  const label = req.body.label === undefined ? undefined : shortString(req.body.label, 100);

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

  /** @type {Record<string, any>} */
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

  recordAuditFromReq(req, 'agent.update', {
    resourceType: 'agent',
    resourceId: req.params.id,
    details: fields,
  });
  res.json({ ok: true });
});

// DELETE /dashboard/api-keys/:id
router.delete('/api-keys/:id', requirePermission('agent:delete'), (req, res) => {
  const result = db
    .prepare(`DELETE FROM api_keys WHERE id = ? AND dashboard_id = ?`)
    .run(req.params.id, req.dashboard.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  bizEvent('dashboard.key_deleted', {
    dashboard_id: req.dashboard.id,
    api_key_id: req.params.id,
    actor: req.user.email,
  });
  recordAuditFromReq(req, 'agent.delete', {
    resourceType: 'agent',
    resourceId: req.params.id,
  });
  res.json({ ok: true });
});

// POST /dashboard/api-keys/:id/suspend
router.post('/api-keys/:id/suspend', requirePermission('agent:suspend'), (req, res) => {
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
  recordAuditFromReq(req, 'agent.suspend', {
    resourceType: 'agent',
    resourceId: req.params.id,
  });
  res.json({ ok: true });
});

// POST /dashboard/api-keys/:id/unsuspend
router.post('/api-keys/:id/unsuspend', requirePermission('agent:suspend'), (req, res) => {
  const result = db
    .prepare(`UPDATE api_keys SET suspended = 0 WHERE id = ? AND dashboard_id = ?`)
    .run(req.params.id, req.dashboard.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  bizEvent('dashboard.agent_unsuspended', {
    dashboard_id: req.dashboard.id,
    api_key_id: req.params.id,
    actor: req.user.email,
  });
  recordAuditFromReq(req, 'agent.unsuspend', {
    resourceType: 'agent',
    resourceId: req.params.id,
  });
  res.json({ ok: true });
});

// ── Approval requests ─────────────────────────────────────────────────────────

// GET /dashboard/approval-requests
router.get('/approval-requests', requirePermission('approval:read'), (req, res) => {
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
router.post(
  '/approval-requests/:id/approve',
  requirePermission('approval:decide'),
  async (req, res) => {
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
    const decisionNote = shortString(req.body.note, 1000);

    // Atomic compare-and-swap on BOTH rows. The first UPDATE guards
    // against the expireApprovalRequests job racing the approve click
    // between the SELECT at line 646 and here (between the async
    // usdToXlm call the window is wide enough to matter). The second
    // UPDATE guards against operating on an order that the expiry job
    // already flipped to 'rejected'. If either guard fails we bail
    // out with 410 Gone — the caller should refresh the approval
    // list.
    const approvalChanged = db
      .prepare(
        `UPDATE approval_requests
         SET status = 'approved', decided_at = ?, decided_by = ?, decision_note = ?
         WHERE id = ? AND status = 'pending' AND datetime(expires_at) >= datetime('now')`,
      )
      .run(now, req.user.email, decisionNote, req.params.id);
    if (approvalChanged.changes === 0) {
      return res.status(410).json({
        error: 'approval_expired_or_decided',
        message:
          'Approval could not be finalised — it may have just expired or been decided by another operator.',
      });
    }
    const orderChanged = db
      .prepare(
        `UPDATE orders
         SET status = 'pending_payment',
             vcc_payment_json = ?,
             updated_at = ?
         WHERE id = ? AND status = 'awaiting_approval'`,
      )
      .run(JSON.stringify(contractPayment), now, approval.order_id);
    if (orderChanged.changes === 0) {
      // Approval row moved to 'approved' but the order is no longer
      // 'awaiting_approval' — shouldn't happen under normal flows,
      // but log it and return a 409 so the operator can investigate.
      bizEvent('approval.order_state_drift', {
        approval_id: req.params.id,
        order_id: approval.order_id,
      });
      return res.status(409).json({
        error: 'order_state_drift',
        message: 'Approval approved but order is no longer in awaiting_approval state.',
      });
    }
    recordDecision(
      approval.api_key_id,
      approval.order_id,
      approval.amount_usdc,
      'approved',
      'owner_approved',
      decisionNote || 'Approved by dashboard owner',
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
    recordAuditFromReq(req, 'approval.approve', {
      resourceType: 'approval',
      resourceId: req.params.id,
      details: {
        order_id: approval.order_id,
        amount_usdc: approval.amount_usdc,
        note: decisionNote,
      },
    });
    res.json({ ok: true });
  },
);

// POST /dashboard/approval-requests/:id/reject
router.post('/approval-requests/:id/reject', requirePermission('approval:decide'), (req, res) => {
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
  const note = shortString(req.body.note, 1000) || 'Rejected';
  // Atomic compare-and-swap: only flip 'pending' → 'rejected'. Guards
  // against the expireApprovalRequests job racing us to 'expired'.
  const approvalChanged = db
    .prepare(
      `UPDATE approval_requests
       SET status = 'rejected', decided_at = ?, decided_by = ?, decision_note = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, req.user.email, note, req.params.id);
  if (approvalChanged.changes === 0) {
    return res.status(409).json({
      error: 'already_decided',
      message: 'Approval could not be rejected — it may have just been decided or expired.',
    });
  }
  db.prepare(
    `UPDATE orders SET status = 'rejected', error = ?, updated_at = ?
     WHERE id = ? AND status = 'awaiting_approval'`,
  ).run(note, now, approval.order_id);
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
  recordAuditFromReq(req, 'approval.reject', {
    resourceType: 'approval',
    resourceId: req.params.id,
    details: {
      order_id: approval.order_id,
      amount_usdc: approval.amount_usdc,
      note,
    },
  });
  res.json({ ok: true });
});

// ── Alert rules ──────────────────────────────────────────────────────────────
//
// Alert rules split into SYSTEM (platform-operator-only) and USER (any
// dashboard owner). System kinds are visible + editable only by the
// caller flagged `req.user.is_platform_owner`. User kinds are scoped
// to the caller's own dashboard via the existing dashboard_id JOIN
// inside the evaluator (see lib/alerts.js).

// GET /dashboard/alert-rules
router.get('/alert-rules', requirePermission('alert:read'), (req, res) => {
  const isPlatformOwner = !!req.user.is_platform_owner;
  // Seed defaults for this dashboard if it has none yet. The seed
  // function knows to skip system kinds for non-platform-owners.
  alerts.seedDefaultRules(req.dashboard.id, { isPlatformOwner });
  res.json({
    rules: alerts.listRules(req.dashboard.id, { isPlatformOwner }),
    available_kinds: isPlatformOwner ? alerts.KNOWN_KINDS : alerts.USER_KINDS,
    is_platform_owner: isPlatformOwner,
  });
});

// POST /dashboard/alert-rules
router.post('/alert-rules', requirePermission('alert:write'), (req, res) => {
  const { name, kind, config, notify_email, notify_webhook_url } = req.body || {};
  if (!name || !kind) return res.status(400).json({ error: 'missing_fields' });
  try {
    const rule = alerts.createRule({
      dashboardId: req.dashboard.id,
      name: String(name).slice(0, 120),
      kind: String(kind),
      config: config || {},
      notifyEmail: notify_email || null,
      notifyWebhookUrl: notify_webhook_url || null,
      isPlatformOwner: !!req.user.is_platform_owner,
    });
    recordAuditFromReq(req, 'alert.create', {
      resourceType: 'alert_rule',
      resourceId: rule?.id,
      details: { kind, name },
    });
    res.status(201).json({ rule });
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    // Distinguish authz vs validation so the frontend can render a
    // sensible error toast.
    const status = /platform owner/i.test(msg) ? 403 : 400;
    res.status(status).json({ error: 'invalid_rule', message: msg });
  }
});

// PATCH /dashboard/alert-rules/:id
router.patch('/alert-rules/:id', requirePermission('alert:write'), (req, res) => {
  const { name, config, enabled, snoozedUntil, notify_email, notify_webhook_url } = req.body || {};
  try {
    const rule = alerts.updateRule(
      req.dashboard.id,
      req.params.id,
      {
        name,
        config,
        enabled,
        snoozedUntil,
        notifyEmail: notify_email,
        notifyWebhookUrl: notify_webhook_url,
      },
      { isPlatformOwner: !!req.user.is_platform_owner },
    );
    if (!rule) return res.status(404).json({ error: 'not_found' });
    recordAuditFromReq(req, 'alert.update', {
      resourceType: 'alert_rule',
      resourceId: req.params.id,
      details: { name, enabled, snoozedUntil },
    });
    res.json({ rule });
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    res.status(/platform owner/i.test(msg) ? 403 : 400).json({
      error: 'update_failed',
      message: msg,
    });
  }
});

// DELETE /dashboard/alert-rules/:id
router.delete('/alert-rules/:id', requirePermission('alert:write'), (req, res) => {
  try {
    const ok = alerts.deleteRule(req.dashboard.id, req.params.id, {
      isPlatformOwner: !!req.user.is_platform_owner,
    });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    recordAuditFromReq(req, 'alert.delete', {
      resourceType: 'alert_rule',
      resourceId: req.params.id,
    });
    res.json({ ok: true });
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    res.status(/platform owner/i.test(msg) ? 403 : 400).json({
      error: 'delete_failed',
      message: msg,
    });
  }
});

// GET /dashboard/alert-firings
router.get('/alert-firings', requirePermission('alert:read'), (req, res) => {
  const q = /** @type {Record<string, any>} */ (req.query);
  const firings = alerts.listFirings(req.dashboard.id, {
    limit: q.limit ? parseInt(q.limit, 10) : undefined,
    isPlatformOwner: !!req.user.is_platform_owner,
  });
  res.json({ firings });
});

// ── Merchants (cards402-enabled catalog) ─────────────────────────────────────

// GET /dashboard/merchants
router.get('/merchants', requirePermission('merchant:read'), (_req, res) => {
  res.json({ merchants: enabledMerchants.listEnabledMerchants() });
});

// ── Webhook delivery log ─────────────────────────────────────────────────────

// GET /dashboard/webhook-deliveries
router.get('/webhook-deliveries', requirePermission('webhook:read'), (req, res) => {
  const q = /** @type {Record<string, any>} */ (req.query);
  const deliveries = webhookLog.listDeliveries(req.dashboard.id, {
    limit: q.limit ? parseInt(q.limit, 10) : undefined,
    apiKeyId: q.api_key_id ? String(q.api_key_id) : undefined,
  });
  res.json({ deliveries });
});

// POST /dashboard/webhook-deliveries/test
// Fires a sample webhook to the caller-supplied URL so an operator can
// verify their endpoint works before an agent goes live. Uses the
// same `fireWebhook` helper so SSRF protection + signing + logging
// all apply uniformly.
router.post('/webhook-deliveries/test', requirePermission('webhook:test'), async (req, res) => {
  const { url, webhook_secret } = req.body || {};
  if (!url) return res.status(400).json({ error: 'missing_url' });

  const testPayload = {
    order_id: `test-${Date.now()}`,
    status: 'delivered',
    amount_usdc: '0.00',
    payment_asset: 'usdc',
    card: { number: '4111 1111 1111 1111', cvv: '123', expiry: '12/30', brand: 'VISA' },
    test: true,
  };

  try {
    await fireWebhookRaw(url, testPayload, webhook_secret || null, null);
    recordAuditFromReq(req, 'webhook.test', {
      resourceType: 'webhook',
      details: { url },
    });
    res.json({ ok: true, note: 'Delivered — check webhook log for details' });
  } catch (err) {
    res.status(502).json({
      error: 'delivery_failed',
      message: /** @type {Error} */ (err).message,
    });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────

// GET /dashboard/audit-log
router.get('/audit-log', requirePermission('audit:read'), (req, res) => {
  const q = /** @type {Record<string, any>} */ (req.query);
  const entries = listAudit(req.dashboard.id, {
    limit: q.limit ? parseInt(q.limit, 10) : undefined,
    offset: q.offset ? parseInt(q.offset, 10) : undefined,
    action: q.action ? String(q.action) : undefined,
    actor: q.actor ? String(q.actor) : undefined,
  });
  res.json({ entries });
});

// ── Policy audit log ──────────────────────────────────────────────────────────

// GET /dashboard/policy-decisions
router.get('/policy-decisions', requirePermission('audit:read'), (req, res) => {
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

// GET /dashboard/platform-wallet — treasury wallet public key + network.
//
// Replaces the legacy /admin/platform-wallet endpoint that used to live on
// the retired admin client. Gated on the deployment-level platform-owner
// flag (CARDS402_PLATFORM_OWNER_EMAIL) so regular dashboard users never
// see treasury internals — only the email that runs the cards402 instance
// can pull this. Balance is fetched client-side from Horizon so the
// backend never has to touch the network on every poll.
router.get('/platform-wallet', requirePlatformOwner, (req, res) => {
  try {
    const { Keypair } = require('@stellar/stellar-sdk');
    const secret = process.env.STELLAR_XLM_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'STELLAR_XLM_SECRET not configured' });
    }
    const keypair = Keypair.fromSecret(secret);
    res.json({
      public_key: keypair.publicKey(),
      network: process.env.STELLAR_NETWORK || 'mainnet',
    });
  } catch (err) {
    res.status(500).json({
      error: 'failed_to_derive_platform_wallet',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

module.exports = router;
