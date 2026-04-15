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

// Adversarial audit F2-permissions (2026-04-15): MATRIX and each of
// its grant arrays are Object.frozen() at module load so no caller can
// silently mutate the RBAC table at runtime. A line like
//   MATRIX.viewer.push('dashboard:delete')
// would otherwise escalate viewers to a destructive permission with no
// git-visible change, no test failure, and no signal in the audit
// log. The grant arrays are frozen individually (Object.freeze is
// shallow) so `.push`/`.splice`/`[0] =` all throw in strict mode.
/** @type {Record<Role, ReadonlyArray<import('./permissions').Permission | '*'>>} */
const MATRIX = Object.freeze({
  owner: Object.freeze(['*']),
  admin: Object.freeze([
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
  ]),
  operator: Object.freeze([
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
  ]),
  viewer: Object.freeze([
    'dashboard:read',
    'agent:read',
    'order:read',
    'approval:read',
    'alert:read',
    'audit:read',
    'merchant:read',
    'webhook:read',
  ]),
});

/** @type {readonly Role[]} */
const KNOWN_ROLES = Object.freeze(['owner', 'admin', 'operator', 'viewer']);

// Single source of truth for every permission string the backend
// recognises. Used by requirePermission() to loud-fail at route
// registration on typos — without this, a handler wired up as
// `requirePermission('agnet:create')` would silently become
// "owner-only" because owners match via the wildcard while every
// other role returns false. Tests run as owner pass, the bug only
// surfaces when a non-owner hits the endpoint in production.
// Adversarial audit F1-permissions.
//
// Keep this set in sync with the Permission typedef above. The
// dashboard:delete / dashboard:update / team:manage / settings:update
// / dashboard:read entries are listed here even though they may only
// be granted via the owner wildcard today, so future handlers can
// use them without tripping the typo guard.
// Frozen array (not a Set) so Object.freeze actually prevents
// mutation. A Set's `.add()` bypasses Object.freeze because it writes
// to an internal slot rather than a property. An attacker or buggy
// refactor inside the process could otherwise do
//   KNOWN_PERMISSIONS.add('bogus:permission')
// and silently register a permission that the requirePermission
// typo-guard then accepts. Frozen array + .includes() is O(19) per
// lookup — negligible for a startup-time typo check.
/** @type {readonly string[]} */
const KNOWN_PERMISSIONS = Object.freeze([
  'dashboard:read',
  'dashboard:update',
  'dashboard:delete',
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
]);

/**
 * Normalise legacy role values to the current model. The original schema
 * had 'user' — we treat those as 'owner' since they're the sole user on
 * their dashboard. Anything unrecognised falls back to 'viewer' for safety.
 *
 * Adversarial audit F1-permissions (2026-04-15): case-insensitive and
 * whitespace-tolerant. The previous implementation did an exact-string
 * match against the lowercase KNOWN_ROLES, so `normalizeRole('Owner')`
 * fell through to `'viewer'`. Every code path that stored a role
 * today used lowercase so the bug was latent, but any future
 * migration, data import, admin DB edit, or team-invite feature that
 * wrote a role with non-canonical casing would silently deauth
 * users across every mutation endpoint — the audit_log row would be
 * misattributed and `requirePermission` would 403 even legitimate
 * owners. Lowercasing + trimming the input before the set check
 * closes the class at the normalization layer.
 *
 * @param {string | null | undefined} role
 * @returns {Role}
 */
function normalizeRole(role) {
  if (typeof role !== 'string') return 'viewer';
  const canonical = role.trim().toLowerCase();
  if (canonical === '') return 'viewer';
  if (canonical === 'user') return 'owner';
  if (KNOWN_ROLES.includes(/** @type {Role} */ (canonical))) {
    return /** @type {Role} */ (canonical);
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
 * F1-permissions: throws synchronously at construction time if the
 * permission string is not in KNOWN_PERMISSIONS. This catches typos at
 * route registration (app startup) instead of at request time — a
 * typo'd handler would otherwise silently become owner-only (wildcard)
 * because only non-owners would fail the check, and the bug would only
 * surface when a non-owner hit the endpoint in production.
 *
 * @param {string} permission
 */
function requirePermission(permission) {
  if (!KNOWN_PERMISSIONS.includes(permission)) {
    throw new Error(
      `requirePermission: unknown permission '${permission}'. ` +
        `Add it to KNOWN_PERMISSIONS in lib/permissions.js or fix the typo. ` +
        `Known: ${[...KNOWN_PERMISSIONS].sort().join(', ')}`,
    );
  }
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
  KNOWN_PERMISSIONS,
  normalizeRole,
  can,
  requirePermission,
};
