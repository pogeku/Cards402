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

// Response-size cap on Horizon fetches. An Horizon account response
// for a normal treasury is ~5–10 KB; outflow pages are ~20–30 KB. A
// 2 MB ceiling gives comfortable headroom for busy accounts while
// refusing to buffer a malicious 30 MB blob from a compromised
// upstream into memory via await res.json(). Beyond 2 MB we abort
// and return an error so /overview and /treasury stay responsive
// under adversarial conditions.
const HORIZON_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

function isHorizonBodyTooBig(res) {
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  return Number.isFinite(len) && len > HORIZON_RESPONSE_MAX_BYTES;
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
    if (isHorizonBodyTooBig(res)) {
      return {
        public_key: publicKey,
        xlm: null,
        usdc: null,
        error: 'horizon response too large',
      };
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

  // F1-platform adversarial audit (2026-04-15): reject array-valued
  // query params up-front instead of letting them reach the SQLite
  // bind layer via String([a,b]) → 'a,b'. The old path silently
  // produced 0 rows for ?status=a&status=b which an operator would
  // reasonably expect to match EITHER status — instead they got an
  // empty response with no signal that the filter was malformed.
  // Matches the same guard I added to /internal/orders in an earlier
  // cycle for consistency across admin surfaces.
  for (const [name, value] of /** @type {[string, unknown][]} */ ([
    ['status', status],
    ['dashboard_id', dashboard_id],
    ['api_key_id', api_key_id],
  ])) {
    if (value !== undefined && typeof value !== 'string') {
      return res.status(400).json({
        error: 'invalid_query_param',
        message: `${name} must be a single string (no repeated ?${name}=... params).`,
      });
    }
  }

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
      if (r.ok && !isHorizonBodyTooBig(r)) {
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
// Explicit column list (not SELECT *) so a future migration that adds
// a sensitive column to unmatched_payments doesn't automatically leak
// it through this read endpoint.
router.get('/unmatched-payments', (req, res) => {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, stellar_txid, sender_address, payment_asset, amount_usdc, amount_xlm,
                claimed_order_id, reason, refund_stellar_txid, created_at
         FROM unmatched_payments
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all()
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
// F2-platform adversarial audit (2026-04-15): match the
// lib/audit.js::listAudit contract by parsing the `details` JSON
// before returning. The dashboard-scoped /dashboard/audit-log
// endpoint (backed by listAudit) returns details as an object;
// this cross-tenant /platform/audit endpoint was returning it as a
// raw string, so any UI that hit both endpoints had to special-case
// the shape. safeParse falls back to the raw string on a JSON parse
// failure — preserves forward-compatibility with any legacy or
// hand-written audit rows that aren't strict JSON.
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
  res.json(
    rows.map((row) => ({
      ...row,
      details: row.details ? safeParseJson(row.details) : null,
    })),
  );
});

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

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
// consecutive_failures counter so the circuit breaker resets.
//
// Adversarial audit (2026-04-15):
//
// F1-platform-unfreeze: write the audit row BEFORE the mutation so a
//   durable paper trail exists even if the mutation itself fails
//   downstream. Emit a loud bizEvent regardless of whether the
//   SQL writes succeed — ops telemetry becomes the last-line signal
//   even if every SQL table is corrupt. We do NOT fail closed here
//   (unlike card reveal) because unfreeze is typically an incident-
//   response action that must not depend on DB liveness.
//
// F2-platform-unfreeze: require a `reason` field (min 10 chars) so
//   the audit trail captures "why", not just "who". Every other
//   sensitive mutation in cards402 already requires justification
//   (approval reject, refund, etc.) — unfreeze was the odd one out.
//
// F3-platform-unfreeze: mirror the write into the unified audit_log
//   table with dashboard_id='system' sentinel, matching the pattern
//   from the card-reveal fix. Ops querying audit_log for platform
//   events no longer has to join two tables.
router.post('/unfreeze', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : '';
  if (reason.length < 10) {
    return res.status(400).json({
      error: 'reason_required',
      message:
        'A `reason` field of at least 10 characters is required to unfreeze the platform. ' +
        'This is captured in the audit trail so the next operator can see why the freeze was lifted.',
    });
  }

  const now = new Date().toISOString();
  const { event: bizEvent } = require('../lib/logger');
  const { recordAudit } = require('../lib/audit');

  // Emit the bizEvent first — cheap, in-memory, and is the last-line
  // signal if every SQL path below fails.
  bizEvent('platform.unfreeze', {
    actor_email: req.user.email,
    reason,
    request_id: req.id || null,
  });

  // Write to admin_actions (platform-scoped table) and audit_log
  // (unified, dashboard-scoped with 'system' sentinel). Either
  // failure is logged but does NOT block the unfreeze — incident
  // response must not depend on DB liveness.
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
      JSON.stringify({ ts: now, reason }),
      req.id || null,
    );
  } catch (err) {
    console.error(
      `[platform] admin_actions insert failed for unfreeze by ${req.user.email}: ${
        /** @type {Error} */ (err).message
      }`,
    );
  }

  // Mirror into audit_log via the hardened recordAudit helper so the
  // entry gets the missing-field guard and the details-size cap that
  // the raw INSERT above bypasses.
  //
  // F3-platform adversarial audit (2026-04-15): coerce the x-forwarded-
  // for and user-agent headers to single strings. Express types these
  // as `string | string[]` because proxies can set them twice via `add`.
  // Passing an array directly into recordAudit() violated the column
  // type contract and produced the only remaining TS2322 warning in
  // this file (same class of fix as the clientIp helper in api/auth.js
  // from an earlier cycle).
  const xff = req.headers?.['x-forwarded-for'];
  const forwarded = Array.isArray(xff) ? xff[0] || null : xff || null;
  const uaHeader = req.headers?.['user-agent'];
  const userAgent = Array.isArray(uaHeader) ? uaHeader[0] || null : uaHeader || null;
  recordAudit({
    dashboardId: 'system',
    actor: { id: req.user.id || null, email: req.user.email, role: req.user.role },
    action: 'platform.unfreeze',
    resourceType: 'system',
    resourceId: 'frozen_flag',
    details: { reason, request_id: req.id || null },
    ip: req.ip || forwarded,
    userAgent,
  });

  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'frozen'`).run();
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'consecutive_failures'`).run();
  res.json({ ok: true, frozen: false });
});

// ── GET /dashboard/platform/margins ──────────────────────────────────────────
//
// Per-order and aggregate margin data for delivered orders. Uses REAL
// cost data when available (ctx_invoice_xlm × settlement_xlm_usd_rate)
// and falls back to the discount estimate for historical orders.
//
// Platform owner only — margin data is operator-sensitive.

router.get('/margins', async (req, res) => {
  const limitRaw = parseInt(/** @type {string} */ (req.query.limit) || '200', 10);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200), 1000);

  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
      SELECT o.id, o.amount_usdc, o.ctx_invoice_xlm, o.settlement_xlm_usd_rate,
             o.payment_asset, o.created_at, o.updated_at, o.status,
             k.label AS api_key_label, d.name AS dashboard_name
      FROM orders o
      LEFT JOIN api_keys k ON o.api_key_id = k.id
      LEFT JOIN dashboards d ON k.dashboard_id = d.id
      WHERE o.status = 'delivered'
      ORDER BY o.created_at DESC
      LIMIT ?
    `,
      )
      .all(limit)
  );

  // No estimates — only real settlement data drives the margin numbers.
  // Orders without ctx_invoice_xlm + settlement_xlm_usd_rate show as
  // "no data" on the frontend. This is honest: the upstream discount
  // varies by product and amount tier, and a hardcoded percentage would
  // be wrong for micro-orders (where CTX likely charges face value with
  // no discount). As new orders come in with real settlement data, the
  // margins page fills in automatically.

  let totalRevenue = 0;
  let totalCtxCost = 0;
  let totalMargin = 0;
  let ordersWithCost = 0;

  const enriched = rows.map((row) => {
    const revenue = parseFloat(row.amount_usdc) || 0;
    totalRevenue += revenue;

    let ctxCostUsd = null;
    let marginUsd = null;
    let marginPct = null;
    let effectiveDiscount = null;
    let hasCostData = false;

    if (row.ctx_invoice_xlm && row.settlement_xlm_usd_rate) {
      const invoiceXlm = parseFloat(row.ctx_invoice_xlm);
      const xlmRate = parseFloat(row.settlement_xlm_usd_rate);
      if (Number.isFinite(invoiceXlm) && Number.isFinite(xlmRate) && xlmRate > 0) {
        ctxCostUsd = invoiceXlm * xlmRate;
        marginUsd = revenue - ctxCostUsd;
        marginPct = revenue > 0 ? (marginUsd / revenue) * 100 : 0;
        effectiveDiscount = revenue > 0 ? ((revenue - ctxCostUsd) / revenue) * 100 : 0;
        hasCostData = true;
        ordersWithCost++;
        totalCtxCost += ctxCostUsd;
        totalMargin += marginUsd;
      }
    }

    return {
      id: row.id,
      amount_usdc: row.amount_usdc,
      ctx_invoice_xlm: row.ctx_invoice_xlm,
      settlement_xlm_usd_rate: row.settlement_xlm_usd_rate,
      ctx_cost_usd: ctxCostUsd !== null ? ctxCostUsd.toFixed(4) : null,
      margin_usd: marginUsd !== null ? marginUsd.toFixed(4) : null,
      margin_pct: marginPct !== null ? marginPct.toFixed(2) : null,
      effective_discount_pct: effectiveDiscount !== null ? effectiveDiscount.toFixed(2) : null,
      has_cost_data: hasCostData,
      payment_asset: row.payment_asset,
      api_key_label: row.api_key_label,
      dashboard_name: row.dashboard_name,
      created_at: row.created_at,
    };
  });

  // Revenue from orders WITH cost data only — so margin % is accurate
  // and not diluted by historical orders we can't price.
  const revenueWithCost = enriched
    .filter((o) => o.has_cost_data)
    .reduce((s, o) => s + (parseFloat(o.amount_usdc) || 0), 0);

  res.json({
    summary: {
      total_revenue_usdc: Number(totalRevenue.toFixed(4)),
      revenue_with_cost_data_usdc: Number(revenueWithCost.toFixed(4)),
      total_ctx_cost_usd: Number(totalCtxCost.toFixed(4)),
      total_margin_usd: Number(totalMargin.toFixed(4)),
      margin_pct:
        revenueWithCost > 0 ? Number(((totalMargin / revenueWithCost) * 100).toFixed(2)) : null,
      delivered_count: rows.length,
      orders_with_cost_data: ordersWithCost,
      orders_without_cost_data: rows.length - ordersWithCost,
    },
    orders: enriched,
  });
});

module.exports = router;
