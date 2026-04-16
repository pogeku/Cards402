// @ts-check
// Audit log helper. Any mutating dashboard action calls recordAudit()
// with a structured event that includes the actor, the resource, and
// arbitrary details JSON. The record is a permanent artefact — no
// mutation, no overwrite — so it can be used for forensics later.
//
// Failure mode: audit writes are best-effort (wrapped in try/catch) so
// a disk issue or race doesn't take down a primary dashboard action.
// Any failure goes to console.error with the full context for ops.

/** @type {any} */
const db = require('../db');
const { normalizeRole } = require('./permissions');

// Cap on the serialised `details` JSON blob. 16KB is generous — even
// the api-key PATCH audit (which captures a full before/after diff of
// every policy field) typically fits in <2KB. Bigger values are
// either a caller bug (dumping a response body into details) or a
// future vector for hostile input bloating the audit_log table.
// Over-cap writes are truncated with a marker rather than rejected so
// the audit trail still captures the event, just with less detail.
// Adversarial audit F2-audit.
const MAX_DETAILS_BYTES = 16 * 1024;

// Cap on listAudit offset. The base query is indexed on
// (dashboard_id, created_at DESC) so typical pagination is cheap, but
// SQLite still walks the index to count through OFFSET rows before
// returning — an authenticated dashboard user can turn
// GET /dashboard/audit-log?offset=99999999 into arbitrary server
// work. 10,000 is far beyond any UI use case (dashboard pages
// typically show 100/page → 100 pages deep before hitting the cap)
// and bounds the blast radius. Adversarial audit F3-audit.
const MAX_LIST_OFFSET = 10_000;

/**
 * @typedef {Object} AuditEvent
 * @property {string} dashboardId
 * @property {{ id?: string | null; email: string; role?: string | null } | null} actor
 * @property {string} action       e.g. 'agent.create'
 * @property {string} [resourceType] e.g. 'agent'
 * @property {string} [resourceId]   e.g. the agent id
 * @property {Record<string, unknown>} [details]
 * @property {string | string[] | null} [ip]
 * @property {string | string[] | null} [userAgent]
 */

const insertStmt = db.prepare(`
  INSERT INTO audit_log (
    dashboard_id,
    actor_user_id,
    actor_email,
    actor_role,
    action,
    resource_type,
    resource_id,
    details,
    ip,
    user_agent
  ) VALUES (
    @dashboard_id,
    @actor_user_id,
    @actor_email,
    @actor_role,
    @action,
    @resource_type,
    @resource_id,
    @details,
    @ip,
    @user_agent
  )
`);

// Adversarial audit F5-audit (2026-04-15): BigInt-safe replacer.
// Plain JSON.stringify throws on BigInt values ("Do not know how to
// serialize a BigInt"), which used to route straight to the
// `_serialise_failed` marker and LOSE the detail data. The Stellar
// watcher (i128 amounts), any SUM() over a large column that SQLite
// may surface as a BigInt, and any caller that plumbs a BigInt
// through a detail field would all silently degrade. lib/logger.js::
// safeStringify already has this replacer; audit.js was inconsistent.
function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Serialise the caller's details object and truncate if over the
 * MAX_DETAILS_BYTES cap. Over-cap writes become a string with a
 * visible marker ({_truncated: true, _original_bytes: N, preview: "..."}
 * encoded as JSON) so forensic reviewers know something was elided
 * and the event itself still lands in the audit trail. Returns null
 * for null/undefined input.
 * @param {Record<string, unknown> | undefined} details
 */
function serialiseDetails(details) {
  if (!details) return null;
  let encoded;
  try {
    encoded = JSON.stringify(details, bigintReplacer);
  } catch (err) {
    // Circular reference or other JSON serialisation failure. Preserve
    // the event but surface the failure mode in the stored blob.
    return JSON.stringify({
      _serialise_failed: true,
      error: /** @type {Error} */ (err).message,
    });
  }
  if (encoded.length <= MAX_DETAILS_BYTES) return encoded;
  // Cap hit. Keep a short preview of the original so ops can still
  // pattern-match on it in queries, and mark the truncation so it
  // doesn't masquerade as a complete record. Use the bigint-safe
  // replacer here too so a BigInt leak in the marker payload doesn't
  // regress to the catch branch.
  return JSON.stringify(
    {
      _truncated: true,
      _original_bytes: encoded.length,
      preview: encoded.slice(0, 512),
    },
    bigintReplacer,
  );
}

/**
 * F7-audit (2026-04-16): defensive coercion of string|string[]|null
 * values that get bound to TEXT columns. Node's http parser returns
 * an array for duplicated headers (x-forwarded-for, user-agent),
 * and better-sqlite3 rejects array binds with
 * `TypeError: SQLite3 can only bind numbers, strings, bigints,
 * buffers, and null`. Pre-fix, the outer try/catch around insertStmt
 * below caught that TypeError and SWALLOWED it — meaning the audit
 * row was silently lost any time a direct caller of recordAudit()
 * (vcc-callback, internal, etc.) passed a raw req.headers[...] value
 * without coercing it first. `recordAuditFromReq` already coerced
 * (F6-audit), but direct callers bypass that helper. Moving the
 * coercion into `recordAudit` itself means every present and future
 * caller is protected at the library boundary without having to
 * audit each call site.
 *
 * Also coerces numbers and other non-string scalars via String() so
 * a caller that accidentally passes a numeric-like value still
 * lands in a valid TEXT column instead of triggering the
 * better-sqlite3 bind type check.
 * @param {unknown} value
 * @returns {string | null}
 */
function coerceTextColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // Take the first non-empty string element; fall back to null.
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }
  // Objects, numbers, bigints — coerce via String() in a try/catch in
  // case toString throws (Proxy, revoked, etc.).
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** @param {AuditEvent} event */
function recordAudit(event) {
  // F1-audit: fail loud on a missing required field instead of letting
  // the NOT NULL constraint quietly throw and the try/catch below
  // swallow the loss. dashboardId and action are schema-required;
  // losing an audit row because a caller forgot one of them is the
  // worst kind of silent failure — the whole point of audit logging
  // is that the row always exists. Console.error (not throw) so a
  // missing-field bug in one path doesn't take down the primary
  // dashboard action that triggered the audit, but it's a loud signal
  // that goes through ops monitoring.
  if (!event || !event.dashboardId || !event.action) {
    console.error(
      `[audit] DROPPED event with missing required field(s). ` +
        `action=${event?.action ?? '<missing>'} ` +
        `dashboardId=${event?.dashboardId ?? '<missing>'} ` +
        `resourceType=${event?.resourceType ?? '<none>'}`,
    );
    return;
  }

  try {
    const role = normalizeRole(event.actor?.role);
    insertStmt.run({
      dashboard_id: event.dashboardId,
      actor_user_id: event.actor?.id ?? null,
      actor_email: event.actor?.email ?? 'system',
      actor_role: role,
      action: event.action,
      resource_type: event.resourceType ?? null,
      resource_id: event.resourceId ?? null,
      details: serialiseDetails(event.details),
      // F7-audit: coerce at the library boundary so direct callers
      // (vcc-callback, internal, etc.) don't have to remember to
      // sanitize header values themselves.
      ip: coerceTextColumn(event.ip),
      user_agent: coerceTextColumn(event.userAgent),
    });
  } catch (err) {
    console.error(
      `[audit] failed to record ${event.action} for ${event.dashboardId}: ${
        /** @type {Error} */ (err).message
      }`,
    );
  }
}

/**
 * Convenience wrapper that pulls dashboard + actor off an Express
 * request and records the event in one call.
 *
 * @param {any} req
 * @param {string} action
 * @param {{ resourceType?: string; resourceId?: string; details?: Record<string, unknown> }} [opts]
 */
function recordAuditFromReq(req, action, opts = {}) {
  const dashboardId = req.dashboard?.id;
  if (!dashboardId) return;
  // F6-audit (2026-04-15): coerce x-forwarded-for and user-agent to
  // a single string before passing to recordAudit. Node's IncomingHttpHeaders
  // types both as `string | string[]` — if a reverse proxy sets the header
  // twice (misconfigured multi-hop, or a buggy client sending UA twice),
  // Node returns an array. better-sqlite3 rejects array binds with a
  // TypeError, which the outer try/catch in recordAudit() logs and
  // SWALLOWS, losing the audit row. The whole point of audit logging is
  // that the row always lands — a hostile or misconfigured upstream
  // should not be able to erase its own trace by double-setting a header.
  // Same class of fix as the clientIp helper in api/auth.js.
  const xff = req.headers?.['x-forwarded-for'];
  const forwarded = Array.isArray(xff) ? xff[0] || null : xff || null;
  const uaHeader = req.headers?.['user-agent'];
  const userAgent = Array.isArray(uaHeader) ? uaHeader[0] || null : uaHeader || null;
  recordAudit({
    dashboardId,
    actor: req.user ? { id: req.user.id, email: req.user.email, role: req.user.role } : null,
    action,
    resourceType: opts.resourceType,
    resourceId: opts.resourceId,
    details: opts.details,
    ip: req.ip || forwarded,
    userAgent,
  });
}

/**
 * Paginated fetch of audit entries for a dashboard, most recent first.
 *
 * @param {string} dashboardId
 * @param {{ limit?: number; offset?: number; action?: string; actor?: string }} [opts]
 */
function listAudit(dashboardId, opts = {}) {
  // F3/F4-audit: normalise NaN and non-finite inputs to the defaults
  // rather than passing them through to SQLite (which rejects
  // `LIMIT NaN` with a 500). Callers pass parseInt() results from
  // query strings, and parseInt('abc') is NaN.
  const rawLimit = Number.isFinite(opts.limit) ? /** @type {number} */ (opts.limit) : 100;
  const rawOffset = Number.isFinite(opts.offset) ? /** @type {number} */ (opts.offset) : 0;
  const limit = Math.min(Math.max(1, rawLimit), 500);
  // F3: cap offset so an authenticated caller can't turn
  // GET /dashboard/audit-log?offset=99999999 into an index walk over
  // 99M rows. 10k is beyond any realistic UI depth.
  const offset = Math.min(Math.max(0, rawOffset), MAX_LIST_OFFSET);
  const conditions = ['dashboard_id = @dashboard_id'];
  /** @type {Record<string, unknown>} */
  const params = { dashboard_id: dashboardId, limit, offset };
  if (opts.action) {
    conditions.push('action = @action');
    params.action = opts.action;
  }
  if (opts.actor) {
    conditions.push('actor_email = @actor');
    params.actor = opts.actor;
  }
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
      SELECT id, dashboard_id, actor_user_id, actor_email, actor_role,
             action, resource_type, resource_id, details, ip, user_agent, created_at
      FROM audit_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY id DESC
      LIMIT @limit OFFSET @offset
      `,
      )
      .all(params)
  );
  return rows.map((r) => ({
    ...r,
    details: r.details ? safeParse(r.details) : null,
  }));
}

/** @param {string} s */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

module.exports = {
  recordAudit,
  recordAuditFromReq,
  listAudit,
  // Test-only export for the 2026-04-16 F7-audit hardening.
  _coerceTextColumn: coerceTextColumn,
};
