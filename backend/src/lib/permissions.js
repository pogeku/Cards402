// @ts-check
// Role-based access control. The backend is single-user-per-dashboard for
// now, but we still want the permission model in place so:
//   1. Sensitive endpoints can require a role server-side
//   2. Adding team members later is a data-model change, not an app rewrite
//   3. The frontend can gate UI visibility off the same canonical matrix
//
// Role hierarchy (most → least privileged):
//   owner    — can do anything, including delete the account
//   admin    — everything except destroying the account
//   operator — create/edit/suspend agents, approve orders, no settings
//   viewer   — read-only (no mutations)
//
// Every existing user maps to `owner` since the current schema has one
// user per dashboard. New users created via a (future) invites flow
// inherit their invited role.

/** @typedef {'owner' | 'admin' | 'operator' | 'viewer'} Role */

/** @typedef {
 *   | 'dashboard:read'
 *   | 'dashboard:update'
 *   | 'dashboard:delete'
 *   | 'agent:read'
 *   | 'agent:create'
 *   | 'agent:update'
 *   | 'agent:delete'
 *   | 'agent:suspend'
 *   | 'order:read'
 *   | 'approval:read'
 *   | 'approval:decide'
 *   | 'alert:read'
 *   | 'alert:write'
 *   | 'audit:read'
 *   | 'team:manage'
 *   | 'settings:update'
 *   | 'merchant:read'
 *   | 'webhook:read'
 *   | 'webhook:test'
 * } Permission */

/** @type {Record<Role, ReadonlyArray<import('./permissions').Permission | '*'>>} */
const MATRIX = {
  owner: ['*'],
  admin: [
    'dashboard:read',
    'dashboard:update',
    'agent:read',
    'agent:create',
    'agent:update',
    'agent:delete',
    'agent:suspend',
    'order:read',
    'approval:read',
    'approval:decide',
    'alert:read',
    'alert:write',
    'audit:read',
    'team:manage',
    'settings:update',
    'merchant:read',
    'webhook:read',
    'webhook:test',
  ],
  operator: [
    'dashboard:read',
    'agent:read',
    'agent:create',
    'agent:update',
    'agent:suspend',
    'order:read',
    'approval:read',
    'approval:decide',
    'alert:read',
    'audit:read',
    'merchant:read',
    'webhook:read',
    'webhook:test',
  ],
  viewer: [
    'dashboard:read',
    'agent:read',
    'order:read',
    'approval:read',
    'alert:read',
    'audit:read',
    'merchant:read',
    'webhook:read',
  ],
};

/** @type {readonly Role[]} */
const KNOWN_ROLES = ['owner', 'admin', 'operator', 'viewer'];

/**
 * Normalise legacy role values to the current model. The original schema
 * had 'user' — we treat those as 'owner' since they're the sole user on
 * their dashboard. Anything unrecognised falls back to 'viewer' for safety.
 *
 * @param {string | null | undefined} role
 * @returns {Role}
 */
function normalizeRole(role) {
  if (role === 'user') return 'owner';
  if (role && KNOWN_ROLES.includes(/** @type {Role} */ (role))) {
    return /** @type {Role} */ (role);
  }
  return 'viewer';
}

/**
 * Return true if a user with `role` is allowed to perform `permission`.
 * Unknown permissions default to deny so a typo can't silently open access.
 *
 * @param {string | null | undefined} role
 * @param {string} permission
 */
function can(role, permission) {
  const normalized = normalizeRole(role);
  const grants = MATRIX[normalized];
  if (!grants) return false;
  if (grants.includes('*')) return true;
  return grants.includes(/** @type {import('./permissions').Permission} */ (permission));
}

/**
 * Express middleware that requires the current session's user to have
 * `permission`. Assumes an earlier middleware put req.user on the request.
 * Responds 403 if the user is authenticated but lacks permission, and
 * 401 if there's no session on the request.
 *
 * @param {string} permission
 */
function requirePermission(permission) {
  return function permissionMiddleware(req, res, next) {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (!can(user.role, permission)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `Requires ${permission}`,
      });
    }
    return next();
  };
}

module.exports = {
  MATRIX,
  KNOWN_ROLES,
  normalizeRole,
  can,
  requirePermission,
};
