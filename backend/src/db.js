// @ts-check
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'cards402.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending_payment',
    amount_usdc TEXT NOT NULL,
    stellar_txid TEXT,
    ctx_order_id TEXT,
    claim_url   TEXT,
    challenge   TEXT,
    reward_url  TEXT,
    card_number TEXT,
    card_cvv    TEXT,
    card_expiry TEXT,
    card_brand  TEXT,
    error       TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    api_key_id  TEXT,
    webhook_url TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    key_hash    TEXT NOT NULL UNIQUE,
    label       TEXT,
    spend_limit_usdc TEXT,
    total_spent_usdc TEXT NOT NULL DEFAULT '0',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS system_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Idempotency keys: cache order creation responses for 24h so retried
  -- requests with the same key get the original response, not a duplicate order.
  -- request_fingerprint is SHA-256(canonical request body) — used to detect key reuse
  -- with a different body (which should return 409, not the cached response).
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key                  TEXT NOT NULL,
    api_key_id           TEXT NOT NULL,
    request_fingerprint  TEXT NOT NULL DEFAULT '',
    response_status      INTEGER NOT NULL,
    response_body        TEXT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (key, api_key_id)
  );

  -- Webhook delivery queue: failed webhook attempts are persisted here for retry.
  -- Max 3 attempts with exponential backoff (30s, 5m, 30m).
  CREATE TABLE IF NOT EXISTS webhook_queue (
    id           TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    payload      TEXT NOT NULL,
    secret       TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_attempt TEXT NOT NULL,
    last_error   TEXT,
    delivered    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Unmatched payments: on-chain payments that arrived but could not be matched
  -- to a pending order (wrong/unknown order_id, wrong asset, duplicate, or post-expiry).
  -- These must be reviewed and refunded manually or by a reconciliation job.
  CREATE TABLE IF NOT EXISTS unmatched_payments (
    id              TEXT PRIMARY KEY,
    stellar_txid    TEXT NOT NULL,
    sender_address  TEXT,
    payment_asset   TEXT,
    amount_usdc     TEXT,
    amount_xlm      TEXT,
    claimed_order_id TEXT,
    reason          TEXT NOT NULL,
    refund_stellar_txid TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Indexes on columns present in the baseline schema
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_api_key_id  ON orders(api_key_id);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at  ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at  ON orders(updated_at);
  CREATE INDEX IF NOT EXISTS idx_orders_stellar_txid ON orders(stellar_txid);
  CREATE INDEX IF NOT EXISTS idx_webhook_queue_next  ON webhook_queue(delivered, next_attempt);
`);

// ── Schema migrations ─────────────────────────────────────────────────────────
// Each migration is identified by a version number stored in system_state.
// Migrations are applied in order and are idempotent — safe to re-run.

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function getSchemaVersion() {
  const row = /** @type {any} */ (
    db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get()
  );
  return row?.v ?? 0;
}

function applyMigration(version, fn) {
  if (getSchemaVersion() >= version) return;
  fn();
  db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(version);
}

// Migration 1: columns added to initial schema
applyMigration(1, () => {
  for (const sql of [
    `ALTER TABLE idempotency_keys ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN payment_asset TEXT DEFAULT 'usdc'`,
    `ALTER TABLE api_keys ADD COLUMN key_prefix TEXT`,
    `ALTER TABLE orders ADD COLUMN payment_xlm_amount TEXT`,
    `ALTER TABLE orders ADD COLUMN sender_address TEXT`,
    `ALTER TABLE orders ADD COLUMN refund_stellar_txid TEXT`,
    `ALTER TABLE api_keys ADD COLUMN webhook_secret TEXT`,
    `ALTER TABLE api_keys ADD COLUMN default_webhook_url TEXT`,
    `ALTER TABLE api_keys ADD COLUMN wallet_public_key TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists — safe */
    }
  }
});

// Indexes on columns added by migration 1
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
`);

// Migration 2: policy engine — spend controls, approval flows, audit log
applyMigration(2, () => {
  // Policy controls on api_keys
  for (const sql of [
    `ALTER TABLE api_keys ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE api_keys ADD COLUMN policy_daily_limit_usdc TEXT`,
    `ALTER TABLE api_keys ADD COLUMN policy_single_tx_limit_usdc TEXT`,
    `ALTER TABLE api_keys ADD COLUMN policy_require_approval_above_usdc TEXT`,
    // JSON: {"start":"09:00","end":"17:00"} — 24h UTC times, null = no restriction
    `ALTER TABLE api_keys ADD COLUMN policy_allowed_hours TEXT`,
    // JSON: [1,2,3,4,5] — 0=Sun … 6=Sat, null = no restriction
    `ALTER TABLE api_keys ADD COLUMN policy_allowed_days TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }

  // Policy audit log — every decision logged here regardless of outcome
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_decisions (
      id          TEXT PRIMARY KEY,
      api_key_id  TEXT NOT NULL,
      order_id    TEXT,
      decision    TEXT NOT NULL,   -- 'approved' | 'blocked' | 'pending_approval'
      rule        TEXT NOT NULL,   -- which rule triggered, e.g. 'daily_limit_exceeded'
      reason      TEXT NOT NULL,
      amount_usdc TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_policy_decisions_api_key ON policy_decisions(api_key_id, created_at);

    -- Approval requests: transactions paused for human review
    CREATE TABLE IF NOT EXISTS approval_requests (
      id            TEXT PRIMARY KEY,
      api_key_id    TEXT NOT NULL,
      order_id      TEXT NOT NULL,
      amount_usdc   TEXT NOT NULL,
      agent_note    TEXT,          -- optional context from the agent
      status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'approved'|'rejected'|'expired'
      requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL, -- 2-hour window before auto-expiry
      decided_at    TEXT,
      decision_note TEXT           -- optional note from owner when deciding
    );
    CREATE INDEX IF NOT EXISTS idx_approval_requests_status    ON approval_requests(status, requested_at);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_api_key   ON approval_requests(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_order     ON approval_requests(order_id);
  `);
});

// Migration 3: user accounts, email auth codes, sessions
applyMigration(3, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      role          TEXT NOT NULL DEFAULT 'user',   -- 'owner' | 'user'
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- Single-use 6-digit codes for email login; expire after 15 minutes
    CREATE TABLE IF NOT EXISTS auth_codes (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, expires_at);

    -- Session tokens; expire after 7 days
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
  `);
});

// Migration 4: agent connection tracking
applyMigration(4, () => {
  try {
    db.prepare(`ALTER TABLE api_keys ADD COLUMN last_used_at TEXT`).run();
  } catch (_) {
    /* already exists */
  }
});

// Migration 5: overpayment tracking and fulfillment heartbeat
applyMigration(5, () => {
  for (const sql of [
    `ALTER TABLE orders ADD COLUMN excess_usdc TEXT`,
    `ALTER TABLE orders ADD COLUMN fulfillment_started_at TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 6: VCC payment proxy — store VCC job ID and payment instructions with each order
applyMigration(6, () => {
  for (const sql of [
    `ALTER TABLE orders ADD COLUMN vcc_job_id TEXT`,
    `ALTER TABLE orders ADD COLUMN vcc_payment_json TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
  try {
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_vcc_job_id ON orders(vcc_job_id)`).run();
  } catch (_) {}
});

// Migration 7: multi-tenancy — each user gets a dashboard; api_keys scoped to a dashboard
applyMigration(7, () => {
  const { v4: uuidv4 } = require('uuid');

  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboards (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name             TEXT NOT NULL DEFAULT 'My Dashboard',
      spend_limit_usdc TEXT,
      frozen           INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dashboards_user_id ON dashboards(user_id);
  `);

  try {
    db.prepare(`ALTER TABLE api_keys ADD COLUMN dashboard_id TEXT REFERENCES dashboards(id)`).run();
  } catch (_) {}
  try {
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_api_keys_dashboard_id ON api_keys(dashboard_id)`,
    ).run();
  } catch (_) {}

  // Create a dashboard for each existing user
  const existingUsers = /** @type {any[]} */ (db.prepare(`SELECT id, email FROM users`).all());
  for (const u of existingUsers) {
    const existing = db.prepare(`SELECT id FROM dashboards WHERE user_id = ?`).get(u.id);
    if (!existing) {
      const dashId = uuidv4();
      const name = u.email.split('@')[0].replace(/[<>&"']/g, '');
      db.prepare(`INSERT INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`).run(
        dashId,
        u.id,
        name,
      );
    }
  }

  // Assign orphan api_keys to the owner's dashboard
  const owner = /** @type {any} */ (
    db.prepare(`SELECT id FROM users WHERE role = 'owner' LIMIT 1`).get()
  );
  if (owner) {
    const ownerDash = /** @type {any} */ (
      db.prepare(`SELECT id FROM dashboards WHERE user_id = ?`).get(owner.id)
    );
    if (ownerDash) {
      db.prepare(`UPDATE api_keys SET dashboard_id = ? WHERE dashboard_id IS NULL`).run(
        ownerDash.id,
      );
    }
  }
});

// Migration 8: add decided_by to approval_requests for audit trail (W-14)
applyMigration(8, () => {
  try {
    db.prepare(`ALTER TABLE approval_requests ADD COLUMN decided_by TEXT`).run();
  } catch (_) {}
});

// Migration 9: sandbox mode, per-key rate limits, time-limited keys, order metadata
applyMigration(9, () => {
  for (const sql of [
    `ALTER TABLE api_keys ADD COLUMN mode TEXT NOT NULL DEFAULT 'live'`,
    `ALTER TABLE api_keys ADD COLUMN rate_limit_rpm INTEGER`,
    `ALTER TABLE api_keys ADD COLUMN expires_at TEXT`,
    `ALTER TABLE orders ADD COLUMN metadata TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 10: stuck-ordering recovery — track whether the CTX XLM payment has
// been sent so the reconciler doesn't double-pay after a mid-flight crash, and
// a heartbeat column so the watchdog can distinguish "just started" from "hung".
applyMigration(10, () => {
  for (const sql of [
    `ALTER TABLE orders ADD COLUMN xlm_sent_at TEXT`,
    `ALTER TABLE orders ADD COLUMN vcc_notified_at TEXT`,
    `ALTER TABLE orders ADD COLUMN fulfillment_attempt INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }

  // Backfill: any existing order sitting in status='ordering' predates the
  // reconciler's checkpoint columns. Without a backfill the reconciler would
  // treat every such order as "xlm_sent_at IS NULL" and retry payCtxOrder,
  // which could double-pay rows that had already paid CTX successfully.
  //
  // Policy: if the row has a vcc_job_id it almost certainly got past
  // getInvoice, and since handlePayment sends XLM immediately after storing
  // vcc_job_id, we assume both xlm_sent_at and vcc_notified_at should be
  // the row's last updated_at. The reconciler then sees "all checkpoints
  // filled" and doesn't touch the row at all — recoverStuckOrders polls vcc
  // separately for the terminal delivery, which is the correct recovery
  // path for pre-existing stuck orders.
  //
  // Rows with NO vcc_job_id are left alone so the reconciler runs them
  // through the full pipeline from scratch (idempotent on vcc's side).
  try {
    db.prepare(
      `
      UPDATE orders
      SET xlm_sent_at = COALESCE(xlm_sent_at, updated_at),
          vcc_notified_at = COALESCE(vcc_notified_at, updated_at)
      WHERE status = 'ordering' AND vcc_job_id IS NOT NULL
    `,
    ).run();
  } catch (_) {
    /* nothing to backfill */
  }
});

// Migration 11: end-to-end request correlation. `orders.request_id` is the
// immutable trace id set when the order is first created; it's propagated
// through the vcc dispatch and callback paths so every log line across both
// services can be joined back to a single request. Audit finding C-1.
applyMigration(11, () => {
  for (const sql of [`ALTER TABLE orders ADD COLUMN request_id TEXT`]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 12: admin action audit log. Every destructive op on /admin/*
// (approve, reject, refund, unfreeze, key create/revoke, dashboard edit)
// records a row here so ops can replay operator decisions. Audit A-17.
applyMigration(12, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id           TEXT PRIMARY KEY,
      actor_email  TEXT NOT NULL,
      action       TEXT NOT NULL,       -- 'approve_order', 'refund_order', etc.
      target_type  TEXT NOT NULL,       -- 'order' | 'api_key' | 'dashboard' | 'system'
      target_id    TEXT,
      metadata     TEXT,                -- JSON blob of action-specific context
      ip           TEXT,
      request_id   TEXT,                -- correlation to the original HTTP request
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_actor ON admin_actions(actor_email, created_at);
    CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at);
  `);
});

// Migration 13: per-job callback nonce. Each invoice dispatch generates a
// unique nonce that's stored on the order AND sent to vcc. The nonce is
// included in the HMAC signing payload so even if VCC_CALLBACK_SECRET leaks,
// an attacker can't forge a callback without the per-order nonce. Audit C-3.
applyMigration(13, () => {
  for (const sql of [`ALTER TABLE orders ADD COLUMN callback_nonce TEXT`]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 14: live agent setup state. Drives the real-time "onboarding
// status" pill in the admin + user dashboards. Agents report transitions
// via POST /v1/agent/status; the backend also derives 'active' once the
// first order is delivered, so agents that never report at all still
// land in the right bucket once they make their first purchase.
//
//   minted            → key created, no API call yet (derived: last_used_at IS NULL)
//   initializing      → agent is spinning up, creating wallet
//   awaiting_funding  → wallet created, address reported, balance not yet seen
//   active            → first delivered order exists (derived)
//
// 'minted' and 'active' are computed at read time so they never drift
// out of sync; the stored column only holds the explicitly-reported
// transient states ('initializing' and 'awaiting_funding').
applyMigration(14, () => {
  for (const sql of [
    `ALTER TABLE api_keys ADD COLUMN agent_state TEXT`,
    `ALTER TABLE api_keys ADD COLUMN agent_state_at TEXT`,
    `ALTER TABLE api_keys ADD COLUMN agent_state_detail TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 15: one-time claim codes for agent onboarding.
//
// An operator mints a new api_key in the dashboard. Instead of pasting
// the raw api_key into the agent's conversation context (where it
// lives forever in the transcript / LLM logs / model memory), the
// dashboard mints a one-time claim code and only shows that in the
// "Send this to your new agent" snippet.
//
// The agent runs `npx cards402 onboard --claim <code>`. The CLI hits
// POST /v1/agent/claim, the backend validates the code (exists, not
// used, not expired), atomically marks it used, and returns the raw
// api_key to the agent over HTTPS. The agent writes it to a local
// config file (~/.cards402/config.json) and the SDK loads from there.
//
// Net effect: the raw api_key never enters the conversation transcript.
// Worst-case leak of the snippet = leak of a one-time 10-minute claim
// code, which is dead the moment the agent uses it. Revoke-from-dashboard
// remains the recovery path if the agent's machine itself is compromised.
applyMigration(15, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_claims (
      id                TEXT PRIMARY KEY,
      code              TEXT NOT NULL UNIQUE,
      api_key_id        TEXT NOT NULL,
      -- Sealed via lib/secret-box (AES-256-GCM with CARDS402_SECRET_BOX_KEY).
      -- Contains the raw 'cards402_...' api key so the claim endpoint can
      -- return it exactly once. DB dump alone doesn't leak the key, because
      -- the sealing key lives in the env.
      sealed_payload    TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT NOT NULL,
      used_at           TEXT,
      claimed_ip        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_claims_code ON agent_claims(code);
    CREATE INDEX IF NOT EXISTS idx_agent_claims_api_key ON agent_claims(api_key_id);
  `);
});

// Migration 16: audit_log table. Every mutating dashboard action emits a
// row so operators can reconstruct "who did what when". The details
// column is JSON for forward-compatibility — new actions don't require
// a schema change.
applyMigration(16, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id    TEXT NOT NULL,
      actor_user_id   TEXT,
      actor_email     TEXT NOT NULL,
      actor_role      TEXT NOT NULL,
      action          TEXT NOT NULL,
      resource_type   TEXT,
      resource_id     TEXT,
      details         TEXT,
      ip              TEXT,
      user_agent      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_dashboard  ON audit_log(dashboard_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor      ON audit_log(actor_email, created_at DESC);
  `);
});

// Migration 17: alert_rules + alert_firings. The evaluator runs against
// each rule every 60s (see lib/alerts/evaluator.js). When a rule trips,
// we append a row to alert_firings and fire the Discord webhook. Rules
// are per-dashboard so team members can tune them independently.
applyMigration(17, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id              TEXT PRIMARY KEY,
      dashboard_id    TEXT NOT NULL,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      config          TEXT NOT NULL DEFAULT '{}',
      enabled         INTEGER NOT NULL DEFAULT 1,
      snoozed_until   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rules_dashboard ON alert_rules(dashboard_id, enabled);
    CREATE TABLE IF NOT EXISTS alert_firings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id         TEXT NOT NULL,
      dashboard_id    TEXT NOT NULL,
      fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
      context         TEXT,
      notified        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_alert_firings_rule  ON alert_firings(rule_id, fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_firings_dash  ON alert_firings(dashboard_id, fired_at DESC);
  `);
});

// Migration 18: webhook_deliveries log. Every outbound webhook we send
// (fulfillment callbacks, test payloads) gets a row with the full
// request body, response code, latency, and signing. Retained 30 days.
applyMigration(18, () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id    TEXT NOT NULL,
      api_key_id      TEXT,
      url             TEXT NOT NULL,
      method          TEXT NOT NULL DEFAULT 'POST',
      request_body    TEXT,
      response_status INTEGER,
      response_body   TEXT,
      latency_ms      INTEGER,
      error           TEXT,
      signature       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_dash ON webhook_deliveries(dashboard_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_key  ON webhook_deliveries(api_key_id, created_at DESC);
  `);
});

// Migration 19: per-rule notification channels. A user-level alert
// rule notifies the configured email and/or webhook URL when it fires;
// system-level rules still go to the operator Discord webhook by
// default but can override via the same columns.
applyMigration(19, () => {
  for (const sql of [
    `ALTER TABLE alert_rules ADD COLUMN notify_email TEXT`,
    `ALTER TABLE alert_rules ADD COLUMN notify_webhook_url TEXT`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists — safe */
    }
  }
});

// Migration 20: expected on-chain payment amounts per order.
//
// orders.amount_usdc is the USDC face value (what we charge).
// expected_xlm_amount is the XLM we quoted to the agent at order-creation
// time for the pay_xlm path. handlePayment compares the on-chain event
// amount against these values and rejects mismatches to unmatched_payments
// so the treasury can't be drained by a tiny pay_xlm/pay_usdc event
// against a real pending_payment order (adversarial audit finding F0).
applyMigration(20, () => {
  for (const sql of [`ALTER TABLE orders ADD COLUMN expected_xlm_amount TEXT`]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 21: per-code verify attempt counter for /auth/verify brute-force
// protection. Adversarial audit F3: before this, /auth/verify had no
// per-email failed-attempt tracking, so a 6-digit code could be guessed
// across 10^6 attempts with nothing to stop it. Failed verifies increment
// failed_attempts on every active code for the email; once any code
// crosses the lockout threshold, all active codes for that email are
// invalidated, forcing a fresh /auth/login.
applyMigration(21, () => {
  for (const sql of [
    `ALTER TABLE auth_codes ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Migration 22: per-order vcc callback secret. Adversarial audit F2:
// previously every vcc job shared process.env.VCC_CALLBACK_SECRET, so a
// single secret leak could forge callbacks for every past and future
// order. Now getInvoice generates a fresh random secret per order, seals
// it via secret-box, stores it here, and ships it to vcc as the per-job
// callback_secret. The vcc-callback handler reads this column for the
// matching order before verifying signatures, so a leaked env secret no
// longer compromises any order that has its own secret.
applyMigration(22, () => {
  for (const sql of [`ALTER TABLE orders ADD COLUMN callback_secret TEXT`]) {
    try {
      db.prepare(sql).run();
    } catch (_) {
      /* column already exists */
    }
  }
});

// Audit A-5: post-migration sanity check. If a newer release has rolled
// through here and bumped the on-disk schema beyond what this binary
// knows about, fail hard instead of running against a schema we don't
// understand. Forward-drift is the dangerous case (older code missing
// columns still in the write path); backward-drift (current code expects
// a column that doesn't exist yet) manifests as a SQLite error on the
// first query.
//
// EXPECTED_SCHEMA_VERSION must match the last `applyMigration(N)` call
// above. Bump it in lock-step with any new migration.
const EXPECTED_SCHEMA_VERSION = 22;
const actualVersion = getSchemaVersion();
if (actualVersion > EXPECTED_SCHEMA_VERSION) {
  console.error(
    `[db] schema version mismatch: code expects ${EXPECTED_SCHEMA_VERSION}, ` +
      `database is at ${actualVersion}. Refusing to start — you are running ` +
      `an older binary against a newer database. Roll forward the binary or ` +
      `restore the DB from a pre-migration backup.`,
  );
  process.exit(1);
}

// Seed default system state
const frozen = db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get();
if (!frozen) {
  db.prepare(`INSERT INTO system_state (key, value) VALUES ('frozen', '0')`).run();
}
const consecutiveFailures = db
  .prepare(`SELECT value FROM system_state WHERE key = 'consecutive_failures'`)
  .get();
if (!consecutiveFailures) {
  db.prepare(`INSERT INTO system_state (key, value) VALUES ('consecutive_failures', '0')`).run();
}

module.exports = db;
