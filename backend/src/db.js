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
const EXPECTED_SCHEMA_VERSION = 13;
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
