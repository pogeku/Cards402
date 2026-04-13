// Client-side permission matrix tests. Mirror the backend test so
// the two stay in lock-step — a drift between them would let the
// dashboard show UI the server then rejects.

import { describe, it, expect } from 'vitest';
import { can, normalizeRole, permissionsFor, type Role } from './permissions';

describe('permissions.normalizeRole', () => {
  it('keeps known roles unchanged', () => {
    const roles: Role[] = ['owner', 'admin', 'operator', 'viewer'];
    for (const r of roles) expect(normalizeRole(r)).toBe(r);
  });

  it('maps legacy "user" to owner', () => {
    expect(normalizeRole('user')).toBe('owner');
  });

  it('falls back to viewer on unknown / empty input', () => {
    expect(normalizeRole(null)).toBe('viewer');
    expect(normalizeRole(undefined)).toBe('viewer');
    expect(normalizeRole('')).toBe('viewer');
    expect(normalizeRole('superadmin')).toBe('viewer');
  });
});

describe('permissions.can', () => {
  it('owner is wildcard', () => {
    expect(can('owner', 'agent:delete')).toBe(true);
    expect(can('owner', 'team:manage')).toBe(true);
    expect(can('owner', 'dashboard:delete')).toBe(true);
  });

  it('admin has all non-destructive permissions', () => {
    expect(can('admin', 'agent:create')).toBe(true);
    expect(can('admin', 'agent:delete')).toBe(true);
    expect(can('admin', 'alert:write')).toBe(true);
    expect(can('admin', 'approval:decide')).toBe(true);
  });

  it('admin cannot delete the account', () => {
    expect(can('admin', 'dashboard:delete')).toBe(false);
  });

  it('operator can create + update + suspend agents', () => {
    expect(can('operator', 'agent:create')).toBe(true);
    expect(can('operator', 'agent:update')).toBe(true);
    expect(can('operator', 'agent:suspend')).toBe(true);
  });

  it('operator cannot delete agents, write alerts, or manage team', () => {
    expect(can('operator', 'agent:delete')).toBe(false);
    expect(can('operator', 'alert:write')).toBe(false);
    expect(can('operator', 'team:manage')).toBe(false);
    expect(can('operator', 'settings:update')).toBe(false);
  });

  it('viewer has every read, no writes', () => {
    expect(can('viewer', 'agent:read')).toBe(true);
    expect(can('viewer', 'order:read')).toBe(true);
    expect(can('viewer', 'audit:read')).toBe(true);
    expect(can('viewer', 'agent:create')).toBe(false);
    expect(can('viewer', 'approval:decide')).toBe(false);
    expect(can('viewer', 'webhook:test')).toBe(false);
  });
});

describe('permissions.permissionsFor', () => {
  it('returns a complete permissions object', () => {
    const keys = permissionsFor('owner');
    // Every permission must be present
    expect(keys['agent:read']).toBe(true);
    expect(keys['agent:delete']).toBe(true);
    expect(keys['dashboard:delete']).toBe(true);
  });

  it('operator matrix sets only granted ones to true', () => {
    const keys = permissionsFor('operator');
    expect(keys['agent:read']).toBe(true);
    expect(keys['agent:create']).toBe(true);
    expect(keys['agent:delete']).toBe(false);
    expect(keys['alert:write']).toBe(false);
  });

  it('viewer matrix has every write permission set to false', () => {
    const keys = permissionsFor('viewer');
    expect(keys['agent:create']).toBe(false);
    expect(keys['agent:update']).toBe(false);
    expect(keys['agent:delete']).toBe(false);
    expect(keys['agent:suspend']).toBe(false);
    expect(keys['approval:decide']).toBe(false);
    expect(keys['alert:write']).toBe(false);
    expect(keys['settings:update']).toBe(false);
  });
});
