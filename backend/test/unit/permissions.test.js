// Permissions matrix unit tests. A role that's supposed to have X
// must have X; a role that isn't must not. Keeps the frontend +
// backend matrices honest against an adversarial auditor who says
// "prove the viewer can't delete agents".

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { can, normalizeRole, requirePermission } = require('../../src/lib/permissions');

describe('permissions.normalizeRole', () => {
  it('keeps known roles unchanged', () => {
    assert.equal(normalizeRole('owner'), 'owner');
    assert.equal(normalizeRole('admin'), 'admin');
    assert.equal(normalizeRole('operator'), 'operator');
    assert.equal(normalizeRole('viewer'), 'viewer');
  });

  it('maps legacy "user" to owner for backward compatibility', () => {
    assert.equal(normalizeRole('user'), 'owner');
  });

  it('falls back to viewer (least privileged) on unknown input', () => {
    assert.equal(normalizeRole(null), 'viewer');
    assert.equal(normalizeRole(undefined), 'viewer');
    assert.equal(normalizeRole(''), 'viewer');
    assert.equal(normalizeRole('superadmin'), 'viewer');
  });
});

describe('permissions.can', () => {
  it('owner is a wildcard', () => {
    assert.equal(can('owner', 'agent:delete'), true);
    assert.equal(can('owner', 'team:manage'), true);
    assert.equal(can('owner', 'dashboard:delete'), true);
  });

  it('admin has every non-destructive permission', () => {
    assert.equal(can('admin', 'agent:delete'), true);
    assert.equal(can('admin', 'agent:create'), true);
    assert.equal(can('admin', 'approval:decide'), true);
    assert.equal(can('admin', 'alert:write'), true);
  });

  it('admin cannot delete the account', () => {
    assert.equal(can('admin', 'dashboard:delete'), false);
  });

  it('operator can create/edit/suspend agents but cannot delete them', () => {
    assert.equal(can('operator', 'agent:create'), true);
    assert.equal(can('operator', 'agent:update'), true);
    assert.equal(can('operator', 'agent:suspend'), true);
    assert.equal(can('operator', 'agent:delete'), false);
  });

  it('operator cannot write alerts or manage team', () => {
    assert.equal(can('operator', 'alert:write'), false);
    assert.equal(can('operator', 'team:manage'), false);
    assert.equal(can('operator', 'settings:update'), false);
  });

  it('viewer is read-only across the board', () => {
    assert.equal(can('viewer', 'agent:read'), true);
    assert.equal(can('viewer', 'order:read'), true);
    assert.equal(can('viewer', 'audit:read'), true);
    assert.equal(can('viewer', 'agent:create'), false);
    assert.equal(can('viewer', 'agent:update'), false);
    assert.equal(can('viewer', 'approval:decide'), false);
  });

  it('unknown permission strings deny by default (no silent typo escalation)', () => {
    assert.equal(can('owner', 'bogus:permission'), true); // owner wildcard allows anything
    assert.equal(can('admin', 'bogus:permission'), false);
    assert.equal(can('operator', 'bogus:permission'), false);
  });
});

describe('permissions.requirePermission middleware', () => {
  function runMiddleware(user, permission) {
    const mw = requirePermission(permission);
    const req = { user };
    let statusCode = null;
    let body = null;
    const res = {
      status(c) {
        statusCode = c;
        return this;
      },
      json(b) {
        body = b;
        return this;
      },
    };
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    return { statusCode, body, nextCalled };
  }

  it('401 when no user on the request', () => {
    const { statusCode, body, nextCalled } = runMiddleware(null, 'agent:read');
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthorized');
    assert.equal(nextCalled, false);
  });

  it('403 when user lacks the permission', () => {
    const user = { email: 'viewer@example.com', role: 'viewer' };
    const { statusCode, body, nextCalled } = runMiddleware(user, 'agent:delete');
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'forbidden');
    assert.equal(nextCalled, false);
  });

  it('calls next() when user has the permission', () => {
    const user = { email: 'owner@example.com', role: 'owner' };
    const { statusCode, nextCalled } = runMiddleware(user, 'agent:delete');
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
  });

  // ── F1-permissions regression: typo guard at construction ───────────────
  //
  // Before the fix, requirePermission('agnet:create') (typo) silently
  // built a middleware that returned true for owners (wildcard) and
  // false for everyone else — turning the endpoint into "owner-only"
  // without anyone noticing. Tests run as owner passed; the bug only
  // surfaced when a non-owner hit the endpoint in production. Now
  // requirePermission throws at construction time so route
  // registration fails loudly at app startup.

  it('throws synchronously on an unknown permission string (typo guard)', () => {
    assert.throws(() => requirePermission('agnet:create'), /unknown permission 'agnet:create'/);
  });

  it('throws on a completely garbage permission string', () => {
    assert.throws(() => requirePermission('bogus:permission'), /unknown permission/);
  });

  it('still accepts every real permission string without throwing', () => {
    // Smoke test: construct each known permission's middleware and
    // verify the module itself doesn't reject it. Keeps the
    // KNOWN_PERMISSIONS set honest with respect to real usage.
    const { KNOWN_PERMISSIONS } = require('../../src/lib/permissions');
    for (const p of KNOWN_PERMISSIONS) {
      const mw = requirePermission(p);
      assert.equal(typeof mw, 'function', `expected middleware for ${p}`);
    }
  });
});
