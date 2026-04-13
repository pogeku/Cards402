// @ts-check
// Alert rules: persisted per-dashboard rules that evaluate on a tick
// against the current system state, fire to Discord / email / webhook
// when tripped, and record each firing in alert_firings so the
// dashboard can show history.
//
// Rule kinds split into two categories:
//
//   SYSTEM (platform-operator only):
//     - ctx_auth_dead          no config; fires when CTX session is dead
//     - circuit_breaker_frozen no config; fires when fulfillment is frozen
//
//   USER (any dashboard owner):
//     - failure_rate_high   { windowMinutes, thresholdPct } — *their own* orders
//     - spend_over          { windowMinutes, thresholdUsd } — *their own* delivered spend
//     - agent_balance_low   { thresholdUsd } — fires when any of their agents'
//                                             on-chain wallet balance < threshold
//
// Authorization is enforced at the API layer: only the platform owner
// (CARDS402_PLATFORM_OWNER_EMAIL) can create or even *see* SYSTEM
// rules; regular dashboard users can only create + see USER rules.
// Evaluators are scoped per-dashboard so a user's "failure_rate_high"
// rule operates on their own orders, not the global fleet.
//
// Notification channels:
//   notify_email          — best-effort email send (uses lib/email.js)
//   notify_webhook_url    — best-effort POST via fireWebhook (SSRF-safe)
//   neither set + system rule → falls back to ops Discord webhook
//   neither set + user rule   → no-op (rule still fires + logs to history)
//
// The evaluator is idempotent per rule per tick — a rule that's
// already tripped within its "cooldown" window (default 15 min) won't
// re-fire so we don't spam channels on a persistent failure mode.

/** @type {any} */
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/** @typedef {'ctx_auth_dead' | 'circuit_breaker_frozen'} SystemKind */
/** @typedef {'failure_rate_high' | 'spend_over' | 'agent_balance_low'} UserKind */
/** @typedef {SystemKind | UserKind} RuleKind */

const SYSTEM_KINDS = /** @type {ReadonlySet<string>} */ (
  new Set(['ctx_auth_dead', 'circuit_breaker_frozen'])
);
const USER_KINDS = /** @type {ReadonlySet<string>} */ (
  new Set(['failure_rate_high', 'spend_over', 'agent_balance_low'])
);

/** @param {string} kind */
function isSystemKind(kind) {
  return SYSTEM_KINDS.has(kind);
}

/** @param {string} kind */
function isUserKind(kind) {
  return USER_KINDS.has(kind);
}

/**
 * Filter a rule list by what the caller is allowed to see. Non-platform
 * owners only get USER kinds; platform owners see everything in their
 * own dashboard (including the seeded SYSTEM rules).
 *
 * @template {{ kind: string }} R
 * @param {R[]} rules
 * @param {boolean} isPlatformOwner
 * @returns {R[]}
 */
function filterByVisibility(rules, isPlatformOwner) {
  if (isPlatformOwner) return rules;
  return rules.filter((r) => isUserKind(r.kind));
}

/**
 * @param {string} dashboardId
 * @param {{ isPlatformOwner?: boolean }} [opts]
 */
function listRules(dashboardId, opts = {}) {
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, dashboard_id, name, kind, config, enabled, snoozed_until,
                notify_email, notify_webhook_url, created_at, updated_at
         FROM alert_rules WHERE dashboard_id = ? ORDER BY created_at ASC`,
      )
      .all(dashboardId)
  );
  const decoded = rows.map((r) => ({
    ...r,
    config: safeParse(r.config),
    enabled: !!r.enabled,
  }));
  return filterByVisibility(decoded, !!opts.isPlatformOwner);
}

function safeParse(s) {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * @param {{
 *   dashboardId: string;
 *   name: string;
 *   kind: string;
 *   config?: Record<string, unknown>;
 *   notifyEmail?: string | null;
 *   notifyWebhookUrl?: string | null;
 *   isPlatformOwner?: boolean;
 * }} input
 */
function createRule(input) {
  if (!isSystemKind(input.kind) && !isUserKind(input.kind)) {
    throw new Error(`Unknown alert rule kind: ${input.kind}`);
  }
  if (isSystemKind(input.kind) && !input.isPlatformOwner) {
    throw new Error(`System alert rules can only be created by the platform owner`);
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO alert_rules
       (id, dashboard_id, name, kind, config, enabled, notify_email, notify_webhook_url)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.dashboardId,
    input.name,
    input.kind,
    JSON.stringify(input.config ?? {}),
    input.notifyEmail ?? null,
    input.notifyWebhookUrl ?? null,
  );
  return listRules(input.dashboardId, { isPlatformOwner: true }).find((r) => r.id === id);
}

/**
 * @param {string} dashboardId
 * @param {string} id
 * @param {Partial<{
 *   name: string;
 *   config: Record<string, unknown>;
 *   enabled: boolean;
 *   snoozedUntil: string | null;
 *   notifyEmail: string | null;
 *   notifyWebhookUrl: string | null;
 * }>} patch
 * @param {{ isPlatformOwner?: boolean }} [opts]
 */
function updateRule(dashboardId, id, patch, opts = {}) {
  const existing = /** @type {any} */ (
    db
      .prepare(`SELECT id, kind FROM alert_rules WHERE id = ? AND dashboard_id = ?`)
      .get(id, dashboardId)
  );
  if (!existing) return null;
  // Visibility check: a non-platform-owner cannot mutate a system rule
  // even if it lives in their own dashboard (it shouldn't, but defence
  // in depth).
  if (isSystemKind(existing.kind) && !opts.isPlatformOwner) {
    throw new Error('System alert rules can only be modified by the platform owner');
  }
  const fields = [];
  /** @type {Record<string, unknown>} */
  const params = { id, dashboard_id: dashboardId };
  if (patch.name !== undefined) {
    fields.push('name = @name');
    params.name = patch.name;
  }
  if (patch.config !== undefined) {
    fields.push('config = @config');
    params.config = JSON.stringify(patch.config);
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = @enabled');
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.snoozedUntil !== undefined) {
    fields.push('snoozed_until = @snoozed_until');
    params.snoozed_until = patch.snoozedUntil;
  }
  if (patch.notifyEmail !== undefined) {
    fields.push('notify_email = @notify_email');
    params.notify_email = patch.notifyEmail;
  }
  if (patch.notifyWebhookUrl !== undefined) {
    fields.push('notify_webhook_url = @notify_webhook_url');
    params.notify_webhook_url = patch.notifyWebhookUrl;
  }
  if (fields.length === 0) {
    return listRules(dashboardId, { isPlatformOwner: true }).find((r) => r.id === id);
  }
  fields.push(`updated_at = datetime('now')`);
  db.prepare(
    `UPDATE alert_rules SET ${fields.join(', ')} WHERE id = @id AND dashboard_id = @dashboard_id`,
  ).run(params);
  return listRules(dashboardId, { isPlatformOwner: true }).find((r) => r.id === id);
}

/**
 * @param {string} dashboardId
 * @param {string} id
 * @param {{ isPlatformOwner?: boolean }} [opts]
 */
function deleteRule(dashboardId, id, opts = {}) {
  const existing = /** @type {any} */ (
    db
      .prepare(`SELECT id, kind FROM alert_rules WHERE id = ? AND dashboard_id = ?`)
      .get(id, dashboardId)
  );
  if (!existing) return false;
  if (isSystemKind(existing.kind) && !opts.isPlatformOwner) {
    throw new Error('System alert rules can only be deleted by the platform owner');
  }
  const result = db
    .prepare(`DELETE FROM alert_rules WHERE id = ? AND dashboard_id = ?`)
    .run(id, dashboardId);
  return result.changes > 0;
}

/**
 * @param {string} dashboardId
 * @param {{ limit?: number; isPlatformOwner?: boolean }} [opts]
 */
function listFirings(dashboardId, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 500);
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT f.id, f.rule_id, f.fired_at, f.context, f.notified, r.name AS rule_name, r.kind
         FROM alert_firings f LEFT JOIN alert_rules r ON r.id = f.rule_id
         WHERE f.dashboard_id = ?
         ORDER BY f.id DESC LIMIT ?`,
      )
      .all(dashboardId, limit)
  );
  const decoded = rows.map((r) => ({
    ...r,
    context: safeParse(r.context),
    notified: !!r.notified,
  }));
  // Same visibility rules as listRules — non-platform-owners never see
  // system kind firings, even if they happen to have a row in the table.
  return decoded.filter((r) => {
    if (!r.kind) return true; // rule deleted; show under generic
    if (isSystemKind(r.kind) && !opts.isPlatformOwner) return false;
    return true;
  });
}

// ── Preset rules seeded on first boot per dashboard ─────────────────────────
//
// Two paths:
//   - Platform owner's dashboard gets BOTH system + user defaults so
//     they immediately have the operator-side guardrails.
//   - Every other dashboard gets only USER defaults — their own
//     spend/failure-rate watchers, scoped to their own agents.

/**
 * @param {string} dashboardId
 * @param {{ isPlatformOwner?: boolean }} [opts]
 */
function seedDefaultRules(dashboardId, opts = {}) {
  const existing = /** @type {any} */ (
    db.prepare(`SELECT COUNT(*) AS c FROM alert_rules WHERE dashboard_id = ?`).get(dashboardId)
  );
  if (existing.c > 0) return;

  if (opts.isPlatformOwner) {
    createRule({
      dashboardId,
      name: 'CTX auth expired',
      kind: 'ctx_auth_dead',
      config: {},
      isPlatformOwner: true,
    });
    createRule({
      dashboardId,
      name: 'Fulfillment frozen',
      kind: 'circuit_breaker_frozen',
      config: {},
      isPlatformOwner: true,
    });
  }

  // Every dashboard (including the platform owner's) gets the user
  // defaults so they see "their own" failure rate and spend pings too.
  createRule({
    dashboardId,
    name: 'My failure rate over 20% (last 30m)',
    kind: 'failure_rate_high',
    config: { windowMinutes: 30, thresholdPct: 20 },
    isPlatformOwner: !!opts.isPlatformOwner,
  });
  createRule({
    dashboardId,
    name: 'My spend over $100 (last hour)',
    kind: 'spend_over',
    config: { windowMinutes: 60, thresholdUsd: 100 },
    isPlatformOwner: !!opts.isPlatformOwner,
  });
}

// ── Evaluator ───────────────────────────────────────────────────────────────

/**
 * Evaluate each enabled rule for a dashboard. Called by the background
 * tick in jobs.js. Fires per-rule notification channels (email +
 * webhook) when a rule trips, falls back to Discord ops webhook only
 * for system kinds with no explicit channel set.
 *
 * @param {string} dashboardId
 * @param {{ now?: number }} [opts]
 */
async function evaluateRules(dashboardId, opts = {}) {
  // We evaluate ALL rules in this dashboard regardless of visibility —
  // visibility gates UI access, not background firing.
  const rules = listRules(dashboardId, { isPlatformOwner: true }).filter((r) => r.enabled);
  const now = opts.now ?? Date.now();
  const firings = [];
  // Cooldown threshold — any firing newer than this wins and suppresses
  // the rule. Computed in SQL so we don't have to worry about JS Date
  // parsing of SQLite's `datetime('now')` format (no trailing Z, which
  // Date.parse interprets inconsistently across platforms).
  const cooldownMinutes = DEFAULT_COOLDOWN_MS / 60000;
  const recentFiringStmt = db.prepare(
    `SELECT 1 AS ok FROM alert_firings
     WHERE rule_id = ? AND datetime(fired_at) > datetime('now', '-${cooldownMinutes} minutes')
     LIMIT 1`,
  );
  for (const rule of rules) {
    if (rule.snoozed_until && Date.parse(rule.snoozed_until) > now) continue;
    const recent = /** @type {any} */ (recentFiringStmt.get(rule.id));
    if (recent) continue;
    const result = evaluate(rule, dashboardId, now);
    if (result.tripped) {
      db.prepare(`INSERT INTO alert_firings (rule_id, dashboard_id, context) VALUES (?, ?, ?)`).run(
        rule.id,
        dashboardId,
        JSON.stringify(result.context),
      );
      firings.push({ rule, context: result.context });
    }
  }
  // Fire notifications out-of-band so one failed channel doesn't block
  // the rest. Each rule picks its own destination(s):
  //   - notify_email set      → email
  //   - notify_webhook_url    → POST via fireWebhook
  //   - system rule, no explicit channel → ops Discord
  //   - user rule, no explicit channel   → no-op (history only)
  if (firings.length > 0) {
    for (const f of firings) {
      void deliverFiring(dashboardId, f.rule, f.context).catch((err) => {
        console.error(`[alerts] notify error for ${f.rule.id}: ${err.message}`);
      });
    }
  }
  return firings;
}

/**
 * @param {string} dashboardId
 * @param {any} rule
 * @param {Record<string, unknown>} context
 */
async function deliverFiring(dashboardId, rule, context) {
  const summary = `${rule.name}: ${JSON.stringify(context)}`;
  let delivered = false;

  if (rule.notify_email) {
    const { sendAlertEmail } = safeRequire('./email');
    if (typeof sendAlertEmail === 'function') {
      try {
        await sendAlertEmail({
          to: rule.notify_email,
          subject: `cards402 alert: ${rule.name}`,
          body: summary,
        });
        delivered = true;
      } catch (err) {
        console.error(`[alerts] email notify failed: ${err.message}`);
      }
    }
  }

  if (rule.notify_webhook_url) {
    const fulfillment = safeRequire('../fulfillment');
    if (typeof fulfillment.fireWebhook === 'function') {
      try {
        await fulfillment.fireWebhook(
          rule.notify_webhook_url,
          {
            type: 'alert.firing',
            rule_id: rule.id,
            rule_name: rule.name,
            kind: rule.kind,
            context,
            dashboard_id: dashboardId,
            fired_at: new Date().toISOString(),
          },
          null,
          null,
        );
        delivered = true;
      } catch (err) {
        console.error(`[alerts] webhook notify failed: ${err.message}`);
      }
    }
  }

  // Fall back to the operator Discord ONLY for system kinds with no
  // explicit channel — user rules without a channel intentionally
  // stay quiet (they still record to alert_firings).
  if (!delivered && isSystemKind(rule.kind)) {
    const { notifyOps } = safeRequire('./notify');
    if (typeof notifyOps === 'function') {
      void notifyOps({ type: 'frozen', error: summary });
    }
  }
}

function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return {};
  }
}

/**
 * @param {{ kind: string; config: Record<string, unknown> }} rule
 * @param {string} dashboardId
 * @param {number} now
 * @returns {{ tripped: boolean; context: Record<string, unknown> }}
 */
function evaluate(rule, dashboardId, now) {
  switch (rule.kind) {
    case 'ctx_auth_dead':
      return { tripped: isCtxAuthDead(), context: { at: new Date(now).toISOString() } };
    case 'circuit_breaker_frozen':
      return {
        tripped: isCircuitFrozen(),
        context: { at: new Date(now).toISOString() },
      };
    case 'failure_rate_high':
      return evaluateFailureRate(rule.config, dashboardId, now);
    case 'spend_over':
      return evaluateSpendOver(rule.config, dashboardId, now);
    case 'agent_balance_low':
      return evaluateAgentBalanceLow(rule.config, dashboardId);
    default:
      return { tripped: false, context: { reason: `unknown_kind_${rule.kind}` } };
  }
}

function isCtxAuthDead() {
  const row = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'ctx_refresh_token'`).get()
  );
  return !row || !row.value;
}

function isCircuitFrozen() {
  const row = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get()
  );
  return !!(row && String(row.value) === '1');
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} dashboardId
 * @param {number} now
 */
function evaluateFailureRate(config, dashboardId, now) {
  const windowMinutes = Number(config.windowMinutes) || 30;
  const thresholdPct = Number(config.thresholdPct) || 20;
  const cutoffMs = now - windowMinutes * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  // Scope to THIS dashboard's orders by joining against api_keys. A
  // user's "my failure rate" rule only ever sees their own agents.
  const row = /** @type {any} */ (
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN o.status IN ('failed','refunded','rejected') THEN 1 ELSE 0 END) AS failed
         FROM orders o
         JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = ? AND o.created_at > ?`,
      )
      .get(dashboardId, cutoffIso)
  );
  const delivered = Number(row?.delivered || 0);
  const failed = Number(row?.failed || 0);
  const total = delivered + failed;
  if (total < 5) {
    return { tripped: false, context: { total } };
  }
  const rate = (failed / total) * 100;
  return {
    tripped: rate >= thresholdPct,
    context: { rate: rate.toFixed(1), threshold: thresholdPct, delivered, failed, windowMinutes },
  };
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} dashboardId
 * @param {number} now
 */
function evaluateSpendOver(config, dashboardId, now) {
  const windowMinutes = Number(config.windowMinutes) || 60;
  const thresholdUsd = Number(config.thresholdUsd) || 100;
  const cutoffMs = now - windowMinutes * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const row = /** @type {any} */ (
    db
      .prepare(
        `SELECT SUM(CAST(o.amount_usdc AS REAL)) AS total
         FROM orders o
         JOIN api_keys k ON o.api_key_id = k.id
         WHERE k.dashboard_id = ? AND o.status = 'delivered' AND o.created_at > ?`,
      )
      .get(dashboardId, cutoffIso)
  );
  const total = Number(row?.total || 0);
  return {
    tripped: total >= thresholdUsd,
    context: { spend: total.toFixed(2), threshold: thresholdUsd, windowMinutes },
  };
}

/**
 * Agent balance low — fires when the recorded total_spent_usdc minus
 * spend_limit_usdc gap is small. We don't have on-chain balance in
 * the DB, so this is a heuristic over the dashboard's own api_keys
 * (specifically: keys that have a spend limit and have used > 80% of
 * it). It's the least-leaky proxy we can compute without polling
 * Horizon from the evaluator.
 *
 * @param {Record<string, unknown>} config
 * @param {string} dashboardId
 */
function evaluateAgentBalanceLow(config, dashboardId) {
  const thresholdRemainingUsd = Number(config.thresholdRemainingUsd) || 10;
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, label, spend_limit_usdc, total_spent_usdc
         FROM api_keys
         WHERE dashboard_id = ?
           AND spend_limit_usdc IS NOT NULL`,
      )
      .all(dashboardId)
  );
  const lowAgents = [];
  for (const r of rows) {
    const limit = parseFloat(r.spend_limit_usdc);
    const spent = parseFloat(r.total_spent_usdc || '0');
    if (!isFinite(limit) || !isFinite(spent)) continue;
    const remaining = limit - spent;
    if (remaining <= thresholdRemainingUsd) {
      lowAgents.push({ id: r.id, label: r.label, remaining });
    }
  }
  return {
    tripped: lowAgents.length > 0,
    context: { lowAgents, threshold: thresholdRemainingUsd },
  };
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listFirings,
  seedDefaultRules,
  evaluateRules,
  isSystemKind,
  isUserKind,
  SYSTEM_KINDS: [...SYSTEM_KINDS],
  USER_KINDS: [...USER_KINDS],
  KNOWN_KINDS: [...SYSTEM_KINDS, ...USER_KINDS],
};
