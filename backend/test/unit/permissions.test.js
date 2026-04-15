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

  // ── F1-permissions (2026-04-15): case-insensitive + trim ────────────
  //
  // Pre-fix, normalizeRole did an exact-string match against the
  // lowercase KNOWN_ROLES. 'Owner' or 'OWNER' fell through to 'viewer',
  // silently deauthing users. No code path wrote non-canonical roles
  // today, but a future migration / import / admin DB edit / team
  // invite feature would have the same silent-failure class. These
  // tests pin the normalization contract so that class stays closed.

  it('F1: uppercase role normalizes to canonical lowercase', () => {
    assert.equal(normalizeRole('OWNER'), 'owner');
    assert.equal(normalizeRole('ADMIN'), 'admin');
    assert.equal(normalizeRole('OPERATOR'), 'operator');
    assert.equal(normalizeRole('VIEWER'), 'viewer');
  });

  it('F1: mixed-case role normalizes', () => {
    assert.equal(normalizeRole('Owner'), 'owner');
    assert.equal(normalizeRole('Admin'), 'admin');
    assert.equal(normalizeRole('OpErAtOr'), 'operator');
  });

  it('F1: leading/trailing whitespace is trimmed before matching', () => {
    assert.equal(normalizeRole('  owner  '), 'owner');
    assert.equal(normalizeRole('\tadmin\n'), 'admin');
    assert.equal(normalizeRole(' Viewer '), 'viewer');
  });

  it('F1: legacy "user" handles case + whitespace variants', () => {
    assert.equal(normalizeRole('User'), 'owner');
    assert.equal(normalizeRole('USER'), 'owner');
    assert.equal(normalizeRole('  user  '), 'owner');
  });

  it('F1: non-string inputs still fall back to viewer (no crash)', () => {
    // Defensive: previous impl did `role && KNOWN_ROLES.includes(role)`
    // which worked on numbers (1.includes doesn't exist; falls to the
    // .includes call on the array, which uses strict equality → false
    // → fallback). Post-fix explicitly checks typeof === 'string' so
    // any numeric or object role input still lands at viewer without
    // surprising behaviour.
    assert.equal(normalizeRole(/** @type {any} */ (42)), 'viewer');
    assert.equal(normalizeRole(/** @type {any} */ ({ role: 'owner' })), 'viewer');
    assert.equal(normalizeRole(/** @type {any} */ (['owner'])), 'viewer');
    assert.equal(normalizeRole(/** @type {any} */ (true)), 'viewer');
  });
});

// ── F2-permissions (2026-04-15): MATRIX is frozen ──────────────────────
//
// Trivial hardening but structurally important for a security-critical
// constant. A runtime mutation like `MATRIX.viewer.push('dashboard:
// delete')` or `MATRIX.owner = []` would otherwise silently change
// access control with no git-visible change, no test failure, and no
// audit signal. These tests pin the freeze guarantee.

describe('permissions — F2 MATRIX freeze', () => {
  const { MATRIX, KNOWN_ROLES, KNOWN_PERMISSIONS } = require('../../src/lib/permissions');

  it('MATRIX itself is frozen', () => {
    assert.equal(Object.isFrozen(MATRIX), true);
  });

  it('each role grant array is individually frozen', () => {
    for (const role of Object.keys(MATRIX)) {
      assert.equal(Object.isFrozen(MATRIX[role]), true, `MATRIX.${role} must be frozen`);
    }
  });

  // CommonJS test files run in sloppy (non-strict) mode, so attempted
  // writes to frozen objects silently fail instead of throwing. The
  // assertions below observe the OUTCOME — the mutation must have no
  // effect — rather than the mechanism (throw vs. silent no-op). The
  // property that matters for security is "the matrix cannot be
  // widened at runtime", and both strict and sloppy modes enforce it
  // via Object.freeze.

  it('F2: assigning to a frozen role grant is a silent no-op', () => {
    const before = MATRIX.viewer;
    // Sloppy mode: this is silently ignored. Strict mode: throws.
    // Either way, MATRIX.viewer must still point at the original
    // frozen array.
    try {
      /** @type {any} */ (MATRIX).viewer = ['*'];
    } catch (_) {
      /* strict mode throws — that's also acceptable */
    }
    assert.strictEqual(MATRIX.viewer, before, 'MATRIX.viewer reference must not change');
    assert.ok(!MATRIX.viewer.includes('*'), 'viewer must not acquire wildcard grant');
  });

  it('F2: pushing to a frozen grant array is a silent no-op', () => {
    const beforeLength = MATRIX.viewer.length;
    try {
      /** @type {any} */ (MATRIX.viewer).push('dashboard:delete');
    } catch (_) {
      /* strict mode throws — acceptable */
    }
    assert.strictEqual(MATRIX.viewer.length, beforeLength, 'viewer array must not grow');
    assert.ok(!MATRIX.viewer.includes('dashboard:delete'));
  });

  it('F2: direct index assignment on a grant array is a silent no-op', () => {
    const before = MATRIX.viewer[0];
    try {
      /** @type {any} */ (MATRIX.viewer)[0] = '*';
    } catch (_) {
      /* strict mode throws — acceptable */
    }
    assert.strictEqual(MATRIX.viewer[0], before, 'first viewer grant must not change');
  });

  it('F2: KNOWN_ROLES is frozen', () => {
    assert.equal(Object.isFrozen(KNOWN_ROLES), true);
    const beforeLength = KNOWN_ROLES.length;
    try {
      /** @type {any} */ (KNOWN_ROLES).push('superadmin');
    } catch (_) {
      /* strict mode throws */
    }
    assert.strictEqual(KNOWN_ROLES.length, beforeLength);
  });

  it('F2: KNOWN_PERMISSIONS is a frozen array (not a mutable Set)', () => {
    // The earlier Set-based KNOWN_PERMISSIONS was unfreezable — Set's
    // internal slot bypasses Object.freeze so `.add()` still worked.
    // Converted to a frozen array so the typo guard can't be widened
    // at runtime by any caller inside the process.
    assert.ok(Array.isArray(KNOWN_PERMISSIONS));
    assert.equal(Object.isFrozen(KNOWN_PERMISSIONS), true);
    const beforeLength = KNOWN_PERMISSIONS.length;
    try {
      /** @type {any} */ (KNOWN_PERMISSIONS).push('bogus:perm');
    } catch (_) {
      /* strict mode throws */
    }
    assert.strictEqual(KNOWN_PERMISSIONS.length, beforeLength);
    assert.ok(!KNOWN_PERMISSIONS.includes('bogus:perm'));
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
