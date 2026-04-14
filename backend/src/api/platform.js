// @ts-check
// Platform-owner cross-tenant API.
//
// All routes here return data AGGREGATED ACROSS EVERY DASHBOARD on the
// deployment. This is the view the cards402 operator gets when they
// want to see the whole platform at once — all orders, all agents,
// all tenants, treasury state, upstream health, and so on.
//
// Auth model: requireAuth → req.user; requirePlatformOwner → 403
// unless req.user.is_platform_owner === true (i.e. the user's email
// matches CARDS402_PLATFORM_OWNER_EMAIL). NO requireDashboard — the
// whole point is these endpoints transcend a single dashboard.
//
// None of these endpoints return raw PAN / CVV / expiry. For a
// card-data reveal with audit trail, use /internal/orders/:id/card,
// which is separately gated by @cards402.com domain + requireCardReveal.

const { Router } = require('express');
/** @type {any} */ const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requirePlatformOwner = require('../middleware/requirePlatformOwner');
const { normalizeCardBrand } = require('../lib/normalize-card');

const router = Router();
router.use(requireAuth);
router.use(requirePlatformOwner);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sysStateInt(key) {
  const row = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(key)
  );
  return parseInt(row?.value || '0', 10) || 0;
}

function capLimit(raw, def = 100, max = 500) {
  const n = parseInt(String(raw ?? def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Live treasury balances via Horizon. Best-effort — if Horizon is
// unreachable we return nulls so /overview still loads.
async function fetchTreasuryBalance() {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret)
    return { public_key: null, xlm: null, usdc: null, error: 'STELLAR_XLM_SECRET not set' };
  const publicKey = Keypair.fromSecret(secret).publicKey();
  const horizon =
    (process.env.STELLAR_NETWORK || 'mainnet') === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
  try {
    const res = await fetch(`${horizon}/accounts/${publicKey}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { public_key: publicKey, xlm: null, usdc: null, error: `horizon http ${res.status}` };
    }
    const body = /** @type {any} */ (await res.json());
    const balances = body.balances || [];
    const xlm = balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    const usdc =
      balances.find((b) => b.asset_type === 'credit_alphanum4' && b.asset_code === 'USDC')
        ?.balance ?? '0';
    return { public_key: publicKey, xlm, usdc, error: null };
  } catch (err) {
    return {
      public_key: publicKey,
      xlm: null,
      usdc: null,
      error: /** @type {any} */ (err)?.message || 'horizon_fetch_failed',
    };
  }
}

// ── GET /overview ─────────────────────────────────────────────────────────────
// KPI cockpit. Everything you want on the first page you land on.
router.get('/overview', async (req, res) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const counts = {
    dashboards: /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM dashboards`).get()).n,
    users: /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n,
    api_keys: /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM api_keys`).get()).n,
    active_agents: /** @type {any} */ (
      db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND suspended = 0`).get()
    ).n,
    orders: /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM orders`).get()).n,
  };

  const statusCounts = /** @type {any[]} */ (
    db.prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC`).all()
  );

  const last24h = /** @type {any} */ (
    db
      .prepare(
        `
    SELECT
      SUM(CASE WHEN status = 'delivered'      THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'failed'         THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'refunded'       THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END) AS refund_pending,
      SUM(CASE WHEN status = 'expired'        THEN 1 ELSE 0 END) AS expired,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN CAST(amount_usdc AS REAL) ELSE 0 END), 0) AS delivered_volume_usd
    FROM orders
    WHERE created_at >= ?
  `,
      )
      .get(since24h)
  );
  const terminal24h = (last24h?.delivered ?? 0) + (last24h?.failed ?? 0) + (last24h?.refunded ?? 0);
  const successRate24h = terminal24h > 0 ? (last24h?.delivered ?? 0) / terminal24h : null;

  const topAgents = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT k.id, k.label, k.dashboard_id, d.name AS dashboard_name, u.email AS owner_email,
           k.total_spent_usdc, k.last_used_at,
           (SELECT COUNT(*) FROM orders WHERE api_key_id = k.id) AS order_count
    FROM api_keys k
    LEFT JOIN dashboards d ON k.dashboard_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    ORDER BY CAST(k.total_spent_usdc AS REAL) DESC
    LIMIT 5
  `,
      )
      .all()
  );

  const watcher = {
    last_ledger: sysStateInt('stellar_start_ledger') || null,
    last_ledger_at:
      /** @type {any} */ (
        db.prepare(`SELECT value FROM system_state WHERE key = 'stellar_start_ledger_at'`).get()
      )?.value || null,
    dead_letter_24h:
      /** @type {any} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM stellar_dead_letter WHERE created_at >= ?`)
          .get(since24h)
      )?.n ?? 0,
  };
  watcher.age_seconds = watcher.last_ledger_at
    ? Math.round((Date.now() - new Date(watcher.last_ledger_at).getTime()) / 1000)
    : null;

  const system = {
    frozen:
      /** @type {any} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get())
        ?.value === '1',
    consecutive_failures: sysStateInt('consecutive_failures'),
    webhooks_failed_permanent_24h:
      /** @type {any} */ (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM webhook_queue WHERE delivered = 0 AND attempts >= 3 AND created_at >= ?`,
          )
          .get(since24h)
      )?.n ?? 0,
    webhook_queue_pending:
      /** @type {any} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM webhook_queue WHERE delivered = 0 AND attempts < 3`)
          .get()
      )?.n ?? 0,
    unmatched_payments:
      /** @type {any} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM unmatched_payments WHERE refund_stellar_txid IS NULL`)
          .get()
      )?.n ?? 0,
    approvals_pending:
      /** @type {any} */ (
        db.prepare(`SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'pending'`).get()
      )?.n ?? 0,
  };

  const treasury = await fetchTreasuryBalance();

  res.json({
    counts,
    status_counts: statusCounts,
    last_24h: {
      total: last24h?.total ?? 0,
      delivered: last24h?.delivered ?? 0,
      failed: last24h?.failed ?? 0,
      refunded: last24h?.refunded ?? 0,
      refund_pending: last24h?.refund_pending ?? 0,
      expired: last24h?.expired ?? 0,
      delivered_volume_usd: Number(last24h?.delivered_volume_usd ?? 0).toFixed(2),
      success_rate: successRate24h,
    },
    top_agents: topAgents,
    watcher,
    system,
    treasury,
    generated_at: new Date().toISOString(),
  });
});

// ── GET /orders ───────────────────────────────────────────────────────────────
// Cross-tenant orders list. Joined with api_keys → dashboards → users so
// each row carries its owning agent label + dashboard name + owner email.
router.get('/orders', (req, res) => {
  const { status, dashboard_id, api_key_id } = /** @type {any} */ (req.query);
  const limit = capLimit(req.query.limit, 100, 500);

  let query = `
    SELECT o.id, o.status, o.amount_usdc, o.payment_asset, o.stellar_txid,
           o.sender_address, o.refund_stellar_txid, o.card_brand,
           o.error, o.failure_count, o.created_at, o.updated_at,
           CASE WHEN o.card_number IS NOT NULL THEN 1 ELSE 0 END AS has_card,
           o.vcc_job_id,
           k.id AS api_key_id, k.label AS api_key_label,
           d.id AS dashboard_id, d.name AS dashboard_name,
           u.email AS owner_email
    FROM orders o
    LEFT JOIN api_keys k ON o.api_key_id = k.id
    LEFT JOIN dashboards d ON k.dashboard_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    WHERE 1 = 1
  `;
  const params = /** @type {any[]} */ ([]);
  if (status) {
    query += ` AND o.status = ?`;
    params.push(String(status));
  }
  if (dashboard_id) {
    query += ` AND d.id = ?`;
    params.push(String(dashboard_id));
  }
  if (api_key_id) {
    query += ` AND k.id = ?`;
    params.push(String(api_key_id));
  }
  query += ` ORDER BY o.created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = /** @type {any[]} */ (db.prepare(query).all(...params));
  for (const row of rows) {
    row.card_brand = normalizeCardBrand(row.card_brand);
  }
  res.json(rows);
});

// ── GET /agents ───────────────────────────────────────────────────────────────
// Every api_key across every dashboard, with owner info and lifetime stats.
router.get('/agents', (req, res) => {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT
      k.id, k.label, k.key_prefix, k.enabled, k.suspended, k.mode, k.rate_limit_rpm,
      k.spend_limit_usdc, k.total_spent_usdc,
      k.policy_daily_limit_usdc, k.policy_single_tx_limit_usdc,
      k.policy_require_approval_above_usdc,
      k.wallet_public_key, k.default_webhook_url,
      k.agent_state, k.agent_state_at, k.agent_state_detail,
      k.last_used_at, k.created_at, k.expires_at,
      d.id AS dashboard_id, d.name AS dashboard_name,
      u.email AS owner_email, u.role AS owner_role,
      (SELECT COUNT(*) FROM orders WHERE api_key_id = k.id) AS order_count,
      (SELECT COUNT(*) FROM orders WHERE api_key_id = k.id AND status = 'delivered') AS delivered_count,
      (SELECT COUNT(*) FROM orders WHERE api_key_id = k.id AND status = 'refunded') AS refunded_count
    FROM api_keys k
    LEFT JOIN dashboards d ON k.dashboard_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    ORDER BY k.last_used_at DESC NULLS LAST, k.created_at DESC
  `,
      )
      .all()
  );
  res.json(rows);
});

// ── GET /users ────────────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT
      u.id, u.email, u.role, u.created_at, u.last_login_at,
      d.id AS dashboard_id, d.name AS dashboard_name, d.frozen AS dashboard_frozen,
      (SELECT COUNT(*) FROM api_keys WHERE dashboard_id = d.id) AS agent_count,
      (SELECT COUNT(*) FROM orders o JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = d.id) AS order_count,
      (SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND datetime(expires_at) > datetime('now')) AS active_sessions
    FROM users u
    LEFT JOIN dashboards d ON d.user_id = u.id
    ORDER BY u.created_at DESC
  `,
      )
      .all()
  );
  res.json(rows);
});

// ── GET /dashboards ───────────────────────────────────────────────────────────
router.get('/dashboards', (req, res) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT
      d.id, d.name, d.frozen, d.spend_limit_usdc, d.created_at,
      u.email AS owner_email, u.id AS owner_user_id, u.role AS owner_role,
      (SELECT COUNT(*) FROM api_keys WHERE dashboard_id = d.id) AS agent_count,
      (SELECT COUNT(*) FROM orders o JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = d.id) AS order_count,
      (SELECT COUNT(*) FROM orders o JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = d.id AND o.created_at >= ?) AS orders_24h,
      (SELECT COALESCE(SUM(CAST(o.amount_usdc AS REAL)), 0)
         FROM orders o JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = d.id AND o.status = 'delivered') AS delivered_volume_usd
    FROM dashboards d
    LEFT JOIN users u ON d.user_id = u.id
    ORDER BY d.created_at DESC
  `,
      )
      .all(since24h)
  );
  res.json(rows);
});

// ── GET /treasury ─────────────────────────────────────────────────────────────
// Live Horizon balance + recent 20 outflows from the treasury account.
router.get('/treasury', async (req, res) => {
  const balance = await fetchTreasuryBalance();
  const outflows = /** @type {any[]} */ ([]);
  if (balance.public_key) {
    const horizon =
      (process.env.STELLAR_NETWORK || 'mainnet') === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';
    try {
      const url = `${horizon}/accounts/${balance.public_key}/payments?order=desc&limit=20`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const body = /** @type {any} */ (await r.json());
        const records = body?._embedded?.records || [];
        for (const rec of records) {
          if (rec.type !== 'payment' && rec.type !== 'path_payment_strict_send') continue;
          const isOutflow = rec.from === balance.public_key;
          if (!isOutflow) continue;
          outflows.push({
            tx_hash: rec.transaction_hash,
            created_at: rec.created_at,
            asset_type: rec.asset_type,
            asset_code: rec.asset_code || 'XLM',
            amount: rec.amount,
            to: rec.to,
            type: rec.type,
          });
        }
      }
    } catch (_err) {
      /* swallow — outflows are informational, balance is the critical bit */
    }
  }
  res.json({ balance, outflows });
});

// ── GET /webhooks ─────────────────────────────────────────────────────────────
// Cross-tenant webhook delivery log with recent pending queue state.
router.get('/webhooks', (req, res) => {
  const limit = capLimit(req.query.limit, 100, 500);
  const deliveries = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT
      wd.id, wd.dashboard_id, wd.api_key_id, wd.url, wd.method,
      wd.response_status, wd.latency_ms, wd.error, wd.created_at,
      k.label AS api_key_label,
      d.name AS dashboard_name,
      u.email AS owner_email
    FROM webhook_deliveries wd
    LEFT JOIN api_keys k ON wd.api_key_id = k.id
    LEFT JOIN dashboards d ON wd.dashboard_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    ORDER BY wd.created_at DESC
    LIMIT ?
  `,
      )
      .all(limit)
  );
  const queue = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, url, attempts, delivered, next_attempt, last_error, created_at
         FROM webhook_queue
         ORDER BY created_at DESC LIMIT 100`,
      )
      .all()
  );
  res.json({ deliveries, queue });
});

// ── GET /approvals ────────────────────────────────────────────────────────────
router.get('/approvals', (req, res) => {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT
      ar.id, ar.api_key_id, ar.order_id, ar.amount_usdc, ar.agent_note,
      ar.status, ar.requested_at, ar.expires_at, ar.decided_at,
      ar.decision_note, ar.decided_by,
      k.label AS api_key_label,
      d.id AS dashboard_id, d.name AS dashboard_name,
      u.email AS owner_email
    FROM approval_requests ar
    LEFT JOIN api_keys k ON ar.api_key_id = k.id
    LEFT JOIN dashboards d ON k.dashboard_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    ORDER BY ar.requested_at DESC
    LIMIT 200
  `,
      )
      .all()
  );
  res.json(rows);
});

// ── GET /unmatched-payments ───────────────────────────────────────────────────
router.get('/unmatched-payments', (req, res) => {
  const rows = /** @type {any[]} */ (
    db.prepare(`SELECT * FROM unmatched_payments ORDER BY created_at DESC LIMIT 200`).all()
  );
  res.json(rows);
});

// ── GET /policy-decisions ─────────────────────────────────────────────────────
router.get('/policy-decisions', (req, res) => {
  const limit = capLimit(req.query.limit, 100, 500);
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT pd.id, pd.api_key_id, pd.order_id, pd.decision, pd.rule, pd.reason,
           pd.amount_usdc, pd.created_at,
           k.label AS api_key_label,
           d.name AS dashboard_name,
           u.email AS owner_email
    FROM policy_decisions pd
    LEFT JOIN api_keys k ON pd.api_key_id = k.id
    LEFT JOIN dashboards d ON k.dashboard_id = d.id
    LEFT JOIN users u ON d.user_id = u.id
    ORDER BY pd.created_at DESC
    LIMIT ?
  `,
      )
      .all(limit)
  );
  res.json(rows);
});

// ── GET /audit ────────────────────────────────────────────────────────────────
router.get('/audit', (req, res) => {
  const limit = capLimit(req.query.limit, 100, 500);
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT al.id, al.dashboard_id, al.actor_email, al.actor_role,
           al.action, al.resource_type, al.resource_id, al.details,
           al.ip, al.created_at,
           d.name AS dashboard_name
    FROM audit_log al
    LEFT JOIN dashboards d ON al.dashboard_id = d.id
    ORDER BY al.created_at DESC
    LIMIT ?
  `,
      )
      .all(limit)
  );
  res.json(rows);
});

// ── GET /health ───────────────────────────────────────────────────────────────
// Platform health snapshot — watcher, dead letter, circuit breaker, recent
// stellar poll errors, webhook backlog.
router.get('/health', (req, res) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const lastLedger = sysStateInt('stellar_start_ledger') || null;
  const lastLedgerAt =
    /** @type {any} */ (
      db.prepare(`SELECT value FROM system_state WHERE key = 'stellar_start_ledger_at'`).get()
    )?.value || null;
  const ageSeconds = lastLedgerAt
    ? Math.round((Date.now() - new Date(lastLedgerAt).getTime()) / 1000)
    : null;

  const deadLetter = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT tx_hash, ledger, error, created_at FROM stellar_dead_letter
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all()
  );

  const webhookBacklog = {
    pending:
      /** @type {any} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM webhook_queue WHERE delivered = 0 AND attempts < 3`)
          .get()
      )?.n ?? 0,
    failed_permanent_24h:
      /** @type {any} */ (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM webhook_queue WHERE delivered = 0 AND attempts >= 3 AND created_at >= ?`,
          )
          .get(since24h)
      )?.n ?? 0,
    total_deliveries_24h:
      /** @type {any} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE created_at >= ?`)
          .get(since24h)
      )?.n ?? 0,
    failed_deliveries_24h:
      /** @type {any} */ (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM webhook_deliveries WHERE created_at >= ? AND (response_status IS NULL OR response_status >= 400)`,
          )
          .get(since24h)
      )?.n ?? 0,
  };

  res.json({
    watcher: {
      last_ledger: lastLedger,
      last_ledger_at: lastLedgerAt,
      age_seconds: ageSeconds,
      healthy: ageSeconds !== null && ageSeconds < 60,
    },
    circuit_breaker: {
      frozen:
        /** @type {any} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get())
          ?.value === '1',
      consecutive_failures: sysStateInt('consecutive_failures'),
    },
    dead_letter: {
      total: /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM stellar_dead_letter`).get())
        .n,
      last_24h:
        /** @type {any} */ (
          db
            .prepare(`SELECT COUNT(*) AS n FROM stellar_dead_letter WHERE created_at >= ?`)
            .get(since24h)
        )?.n ?? 0,
      recent: deadLetter,
    },
    webhook_backlog: webhookBacklog,
    unmatched_payments:
      /** @type {any} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM unmatched_payments WHERE refund_stellar_txid IS NULL`)
          .get()
      )?.n ?? 0,
  });
});

// ── POST /unfreeze ────────────────────────────────────────────────────────────
// Flip the platform-wide frozen flag back to 0. Also clears the
// consecutive_failures counter so the circuit breaker resets. Logged
// to admin_actions for audit.
router.post('/unfreeze', (req, res) => {
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'frozen'`).run();
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'consecutive_failures'`).run();
  try {
    db.prepare(
      `INSERT INTO admin_actions (id, actor_email, action, target_type, target_id, metadata, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      require('crypto').randomUUID(),
      req.user.email,
      'platform.unfreeze',
      'system',
      null,
      JSON.stringify({ ts: new Date().toISOString() }),
      req.id || null,
    );
  } catch (_err) {
    /* admin_actions write is best-effort */
  }
  res.json({ ok: true, frozen: false });
});

module.exports = router;
