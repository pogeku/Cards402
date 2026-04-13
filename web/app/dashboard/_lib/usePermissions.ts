// React binding for the permissions matrix. Reads the current user's
// role from DashboardProvider and returns a `can` function + a cached
// lookup object so components don't re-call can() for every button.

'use client';

import { useMemo } from 'react';
import { useDashboard } from './DashboardProvider';
import { can, normalizeRole, permissionsFor, type Permission, type Role } from './permissions';

export interface PermissionsApi {
  role: Role;
  can: (permission: Permission) => boolean;
  all: Record<Permission, boolean>;
}

export function usePermissions(): PermissionsApi {
  const { user } = useDashboard();
  return useMemo(() => {
    const role = normalizeRole(user?.role);
    return {
      role,
      can: (permission: Permission) => can(role, permission),
      all: permissionsFor(role),
    };
  }, [user?.role]);
}
