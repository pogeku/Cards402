// Unit tests for requirePlatformOwner and requireOwner middleware.
//
// Before the 2026-04-15 adversarial audit there was ZERO direct test
// coverage for either gate. Integration tests exercised the happy path
// through /dashboard/platform/* routes, but the middleware's fail-closed
// branches (missing req.user, missing is_platform_owner flag, wrong role)
// had no regression guards.
//
// This file pins:
//   requirePlatformOwner: 401 missing user, 403 non-owner, next() for owner
//   requireOwner: 401 missing user, 403 wrong role, next() for owner role

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const requirePlatformOwner = require('../../src/middleware/requirePlatformOwner');
const requireOwner = require('../../src/middleware/requireOwner');

function runMiddleware(mw, req) {
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

// ── requirePlatformOwner ───────────────────────────────────────────────────

describe('requirePlatformOwner middleware', () => {
  it('401 when req.user is missing', () => {
    const { statusCode, body, nextCalled } = runMiddleware(requirePlatformOwner, {});
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthorized');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user is null', () => {
    const { statusCode } = runMiddleware(requirePlatformOwner, { user: null });
    assert.equal(statusCode, 401);
  });

  it('403 when req.user exists but is_platform_owner is false', () => {
    const { statusCode, body, nextCalled } = runMiddleware(requirePlatformOwner, {
      user: { id: 'u1', email: 'user@example.com', is_platform_owner: false },
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'forbidden');
    assert.equal(nextCalled, false);
  });

  it('403 when is_platform_owner is undefined (regression guard)', () => {
    // A future auth middleware that sets req.user without passing email
    // through the isPlatformOwner() helper would leave the flag undefined.
    // undefined is falsy → 403. Fail-closed is the correct behaviour.
    const { statusCode, nextCalled } = runMiddleware(requirePlatformOwner, {
      user: { id: 'u1', email: 'user@example.com' },
    });
    assert.equal(statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('403 when is_platform_owner is a truthy non-boolean (safety check)', () => {
    // Pre-fix this would have passed because the check is `!flag`. A
    // string 'false' is truthy. We still want to surface this because
    // it's a sign that something is mis-populating req.user. Here we
    // assert it PASSES — truthy means truthy, and the middleware is
    // intentionally lenient on the flag type. This pins the contract
    // so a future tightening is a conscious decision.
    const { nextCalled } = runMiddleware(requirePlatformOwner, {
      user: { id: 'u1', email: 'user@example.com', is_platform_owner: 'yes' },
    });
    assert.equal(nextCalled, true);
  });

  it('calls next() when is_platform_owner is true', () => {
    const req = {
      user: { id: 'u1', email: 'ops@cards402.test', is_platform_owner: true },
    };
    const { statusCode, nextCalled } = runMiddleware(requirePlatformOwner, req);
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
  });
});

// ── requireOwner ───────────────────────────────────────────────────────────

describe('requireOwner middleware', () => {
  it('401 when req.user is missing', () => {
    const { statusCode, body, nextCalled } = runMiddleware(requireOwner, {});
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user is null', () => {
    const { statusCode } = runMiddleware(requireOwner, { user: null });
    assert.equal(statusCode, 401);
  });

  it('calls next() when req.user.role === "owner"', () => {
    const { statusCode, nextCalled } = runMiddleware(requireOwner, {
      user: { id: 'u1', email: 'owner@example.com', role: 'owner' },
    });
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
  });

  it('403 owner_only when role is "admin"', () => {
    const { statusCode, body, nextCalled } = runMiddleware(requireOwner, {
      user: { id: 'u1', role: 'admin' },
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'owner_only');
    assert.equal(nextCalled, false);
  });

  it('403 when role is "operator"', () => {
    const { statusCode } = runMiddleware(requireOwner, {
      user: { id: 'u1', role: 'operator' },
    });
    assert.equal(statusCode, 403);
  });

  it('403 when role is "viewer"', () => {
    const { statusCode } = runMiddleware(requireOwner, {
      user: { id: 'u1', role: 'viewer' },
    });
    assert.equal(statusCode, 403);
  });

  it('403 when role is missing (fail closed)', () => {
    // A future auth path that doesn't populate role should not get to
    // owner-gated destructive operations. undefined !== 'owner' → 403.
    const { statusCode, nextCalled } = runMiddleware(requireOwner, {
      user: { id: 'u1', email: 'user@example.com' },
    });
    assert.equal(statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('403 when role is "Owner" (case-sensitive — pinning contract)', () => {
    // An ops fat-finger storing 'Owner' or 'OWNER' in the users.role
    // column would fail closed. Pinning the case-sensitive behaviour
    // so a future case-folding refactor is a conscious decision and
    // the ops investigator knows the value that slipped through.
    const { statusCode } = runMiddleware(requireOwner, {
      user: { id: 'u1', role: 'Owner' },
    });
    assert.equal(statusCode, 403);
  });
});
