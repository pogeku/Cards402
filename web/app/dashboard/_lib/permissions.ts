// Client-side mirror of backend/src/lib/permissions.js. Kept as a
// parallel file instead of a shared package because the two sides are
// in separate runtime environments — the matrix itself is small enough
// that drift is detectable by audit (and covered by tests).
//
// If the backend matrix changes and this file doesn't, the client will
// show UI the server later rejects — tests in _lib/permissions.test.ts
// cover the matrix shape so that's hard to miss.

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export type Permission =
  | 'dashboard:read'
  | 'dashboard:update'
  | 'dashboard:delete'
  | 'agent:read'
  | 'agent:create'
  | 'agent:update'
  | 'agent:delete'
  | 'agent:suspend'
  | 'order:read'
  | 'approval:read'
  | 'approval:decide'
  | 'alert:read'
  | 'alert:write'
  | 'audit:read'
  | 'team:manage'
  | 'settings:update'
  | 'merchant:read'
  | 'webhook:read'
  | 'webhook:test';

// Wildcard marker for owner — stored as a separate symbol so `includes`
// against a typed Permission array still compiles.
const ALL = '*' as const;

const MATRIX: Record<Role, ReadonlyArray<Permission | typeof ALL>> = {
  owner: [ALL],
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

const KNOWN_ROLES: readonly Role[] = ['owner', 'admin', 'operator', 'viewer'];

export function normalizeRole(role: string | null | undefined): Role {
  const r = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (r === 'user') return 'owner'; // legacy schema value
  if (r && (KNOWN_ROLES as readonly string[]).includes(r)) {
    return r as Role;
  }
  return 'viewer';
}

export function can(role: string | null | undefined, permission: Permission): boolean {
  const normalized = normalizeRole(role);
  const grants = MATRIX[normalized];
  if (!grants) return false;
  if (grants.includes(ALL)) return true;
  return grants.includes(permission);
}

// Returns a stable object describing permission checks for a given role.
// Useful for spread-into-props patterns like `const perms = useCan();`.
export function permissionsFor(role: string | null | undefined): Record<Permission, boolean> {
  const out = {} as Record<Permission, boolean>;
  const permissionKeys: Permission[] = [
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
  ];
  for (const p of permissionKeys) out[p] = can(role, p);
  return out;
}
