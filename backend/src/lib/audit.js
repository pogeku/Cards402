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

/**
 * @typedef {Object} AuditEvent
 * @property {string} dashboardId
 * @property {{ id?: string | null; email: string; role?: string | null } | null} actor
 * @property {string} action       e.g. 'agent.create'
 * @property {string} [resourceType] e.g. 'agent'
 * @property {string} [resourceId]   e.g. the agent id
 * @property {Record<string, unknown>} [details]
 * @property {string} [ip]
 * @property {string} [userAgent]
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

/** @param {AuditEvent} event */
function recordAudit(event) {
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
      details: event.details ? JSON.stringify(event.details) : null,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
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
  recordAudit({
    dashboardId,
    actor: req.user ? { id: req.user.id, email: req.user.email, role: req.user.role } : null,
    action,
    resourceType: opts.resourceType,
    resourceId: opts.resourceId,
    details: opts.details,
    ip: req.ip || req.headers?.['x-forwarded-for'] || null,
    userAgent: req.headers?.['user-agent'] || null,
  });
}

/**
 * Paginated fetch of audit entries for a dashboard, most recent first.
 *
 * @param {string} dashboardId
 * @param {{ limit?: number; offset?: number; action?: string; actor?: string }} [opts]
 */
function listAudit(dashboardId, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const offset = Math.max(0, opts.offset ?? 0);
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

module.exports = { recordAudit, recordAuditFromReq, listAudit };
