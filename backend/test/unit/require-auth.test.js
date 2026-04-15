// Unit tests for src/middleware/requireAuth.js.
//
// Before the 2026-04-15 adversarial audit there was ZERO direct test
// coverage for this module. Integration tests exercise the happy path
// through the dashboard routes, but the header-coercion and
// whitespace-tolerance edge cases had no regression guards.
//
// This file covers:
//
//   F1-requireAuth: defensive coercion of an array-valued Authorization
//                   header (double-set by a misconfigured proxy or a
//                   hostile client). Pre-fix this cascaded to a 500 via
//                   TypeError on `array.replace`; post-fix it's a clean
//                   401.
//
//   F2-requireAuth: token is trimmed after stripping 'Bearer ' so a
//                   trailing newline / whitespace from a sloppy client
//                   doesn't desync the hash and bounce a legit user.
//
// Plus baseline: happy path, missing header, malformed header, expired
// session, non-existent session, case-insensitive 'Bearer' prefix.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb } = require('../helpers/app');

const requireAuth = require('../../src/middleware/requireAuth');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function seedUser(email = 'user@cards402.com', role = 'owner') {
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, email, role) VALUES (?, ?, ?)`).run(id, email, role);
  return id;
}

function seedSession(userId, { expiresAt } = {}) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const exp = expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`).run(
    uuidv4(),
    userId,
    hashToken(rawToken),
    exp,
  );
  return rawToken;
}

function runMiddleware(headers) {
  const req = { headers };
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
  requireAuth(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, body, nextCalled, req };
}

// ── baseline ────────────────────────────────────────────────────────────────

describe('requireAuth — baseline', () => {
  beforeEach(() => resetDb());

  it('401 when Authorization header is missing', () => {
    const { statusCode, body, nextCalled } = runMiddleware({});
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthorized');
    assert.equal(nextCalled, false);
  });

  it('401 when the header has no token after "Bearer "', () => {
    const { statusCode } = runMiddleware({ authorization: 'Bearer   ' });
    assert.equal(statusCode, 401);
  });

  it('401 when the token does not match any session', () => {
    seedUser();
    const { statusCode } = runMiddleware({ authorization: 'Bearer notarealtoken' });
    assert.equal(statusCode, 401);
  });

  it('accepts a valid token and attaches req.user', () => {
    const userId = seedUser('alice@cards402.com', 'owner');
    const token = seedSession(userId);
    const { statusCode, nextCalled, req } = runMiddleware({
      authorization: `Bearer ${token}`,
    });
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
    assert.equal(req.user.id, userId);
    assert.equal(req.user.email, 'alice@cards402.com');
    assert.equal(req.user.role, 'owner');
    assert.equal(typeof req.user.is_platform_owner, 'boolean');
  });

  it('accepts case-insensitive "bearer" prefix', () => {
    const userId = seedUser();
    const token = seedSession(userId);
    const { nextCalled } = runMiddleware({ authorization: `bearer ${token}` });
    assert.equal(nextCalled, true);
  });

  it('401 for an expired session', () => {
    const userId = seedUser();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const token = seedSession(userId, { expiresAt: yesterday });
    const { statusCode, nextCalled } = runMiddleware({
      authorization: `Bearer ${token}`,
    });
    assert.equal(statusCode, 401);
    assert.equal(nextCalled, false);
  });
});

// ── F1-requireAuth: defensive header coercion ──────────────────────────────
//
// A duplicated Authorization header makes Node's http parser return
// `string | string[]`. Pre-fix, `array?.replace` called `undefined` as a
// function and cascaded to 500. Post-fix it's a clean 401 (first-element
// coercion for the single-value case, fail-closed for pathological values).

describe('F1-requireAuth: defensive Authorization header coercion', () => {
  beforeEach(() => resetDb());

  it('does not crash on an array-valued Authorization header', () => {
    const userId = seedUser();
    const token = seedSession(userId);
    // Double-set header — Node http parser returns an array.
    const { statusCode, nextCalled, req } = runMiddleware({
      authorization: [`Bearer ${token}`, `Bearer ${token}`],
    });
    // Pre-fix this threw TypeError. Post-fix the first element is used.
    assert.notEqual(statusCode, 500);
    assert.equal(nextCalled, true);
    assert.equal(req.user.id, userId);
  });

  it('401 when array-valued header first element is not a valid token', () => {
    seedUser();
    const { statusCode } = runMiddleware({
      authorization: ['Bearer notarealtoken', 'Bearer alsobogus'],
    });
    assert.equal(statusCode, 401);
  });

  it('401 when Authorization header is a non-string non-array value', () => {
    // Hostile or misconfigured middleware injecting a numeric header value.
    // Pre-fix this would have crashed on `.replace`.
    const { statusCode } = runMiddleware({ authorization: /** @type {any} */ (42) });
    assert.equal(statusCode, 401);
  });

  it('401 when Authorization header is an empty array', () => {
    const { statusCode } = runMiddleware({ authorization: [] });
    assert.equal(statusCode, 401);
  });

  it('401 when Authorization header is an array of non-strings', () => {
    const { statusCode } = runMiddleware({
      authorization: /** @type {any} */ ([42, { foo: 'bar' }]),
    });
    assert.equal(statusCode, 401);
  });
});

// ── F2-requireAuth: token whitespace tolerance ─────────────────────────────
//
// Pre-fix, a trailing space / newline in the header stayed in the
// extracted token. hashToken('xyz ') != hashToken('xyz'), so the legit
// session holder bounced with a confusing 401. Post-fix the token is
// trimmed after stripping the prefix.

describe('F2-requireAuth: token trimmed after Bearer strip', () => {
  beforeEach(() => resetDb());

  it('accepts a token with trailing whitespace', () => {
    const userId = seedUser();
    const token = seedSession(userId);
    const { statusCode, nextCalled } = runMiddleware({
      authorization: `Bearer ${token} `,
    });
    assert.equal(statusCode, null, 'trailing space should not bounce a valid token');
    assert.equal(nextCalled, true);
  });

  it('accepts a token with trailing CRLF', () => {
    const userId = seedUser();
    const token = seedSession(userId);
    const { nextCalled } = runMiddleware({
      authorization: `Bearer ${token}\r\n`,
    });
    assert.equal(nextCalled, true);
  });

  it('accepts a token with a trailing tab', () => {
    const userId = seedUser();
    const token = seedSession(userId);
    const { nextCalled } = runMiddleware({ authorization: `Bearer ${token}\t` });
    assert.equal(nextCalled, true);
  });

  it('still 401s a different token (trim does not make tokens collide)', () => {
    // Sanity: trim is just whitespace removal, not fuzzy matching.
    seedUser();
    const { statusCode } = runMiddleware({ authorization: 'Bearer totallywrong ' });
    assert.equal(statusCode, 401);
  });

  it('whitespace-only token after strip still 401s', () => {
    const { statusCode } = runMiddleware({ authorization: 'Bearer    \t\r\n   ' });
    assert.equal(statusCode, 401);
  });
});
