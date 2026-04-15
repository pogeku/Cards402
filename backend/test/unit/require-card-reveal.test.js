// Unit tests for backend/src/middleware/requireCardReveal.
//
// This is the most sensitive middleware in the system — it gates the
// endpoint that returns plaintext PAN/CVV/expiry. Previously it had
// zero direct test coverage. These tests lock in the current contract:
//
//   - no req.user → 401
//   - req.user with missing/empty email → 401 (defence against a
//     future auth path that sets req.user without email)
//   - CARDS402_CARD_REVEAL_EMAILS unset → 403 (fail-closed default)
//   - CARDS402_CARD_REVEAL_EMAILS set but user not in list → 403
//   - user in list → next() is called, no status written
//   - case-insensitive matching (email normalisation)
//   - whitespace in env entries is trimmed

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const MIDDLEWARE_PATH = require.resolve('../../src/middleware/requireCardReveal');

function freshMiddleware() {
  delete require.cache[MIDDLEWARE_PATH];
  return require('../../src/middleware/requireCardReveal');
}

function runMiddleware(middleware, user) {
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
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, body, nextCalled };
}

describe('requireCardReveal — auth gate', () => {
  let origEnv;

  beforeEach(() => {
    origEnv = process.env.CARDS402_CARD_REVEAL_EMAILS;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    else process.env.CARDS402_CARD_REVEAL_EMAILS = origEnv;
  });

  it('401 when req.user is missing', () => {
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    const { statusCode, body, nextCalled } = runMiddleware(mw, null);
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user has no email (F2 defence)', () => {
    // A future auth middleware that sets req.user via a different path
    // could omit email; the old code would crash on .toLowerCase().
    // This guard catches that fail-closed rather than cascading to 500.
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const { statusCode, body, nextCalled } = runMiddleware(mw, { id: 'u1' });
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user.email is empty string', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const { statusCode, body } = runMiddleware(mw, { id: 'u1', email: '' });
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
  });

  it('401 when req.user.email is a non-string type', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 42 });
    assert.equal(statusCode, 401);
  });
});

describe('requireCardReveal — allowlist', () => {
  let origEnv;

  beforeEach(() => {
    origEnv = process.env.CARDS402_CARD_REVEAL_EMAILS;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    else process.env.CARDS402_CARD_REVEAL_EMAILS = origEnv;
  });

  it('403 card_reveal_disabled when env var is unset (fail-closed default)', () => {
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    const { statusCode, body, nextCalled } = runMiddleware(mw, {
      id: 'u1',
      email: 'ops@cards402.com',
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'card_reveal_disabled');
    assert.equal(nextCalled, false);
  });

  it('403 card_reveal_disabled when env var is empty string', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = '';
    const mw = freshMiddleware();
    const { statusCode, body } = runMiddleware(mw, { id: 'u1', email: 'ops@cards402.com' });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'card_reveal_disabled');
  });

  it('403 card_reveal_disabled when env var is whitespace only', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = '   ,  ,   ';
    const mw = freshMiddleware();
    const { statusCode, body } = runMiddleware(mw, { id: 'u1', email: 'ops@cards402.com' });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'card_reveal_disabled');
  });

  it('403 forbidden when user email is not in the allowlist', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const { statusCode, body, nextCalled } = runMiddleware(mw, {
      id: 'u1',
      email: 'other@cards402.com',
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'forbidden');
    assert.equal(nextCalled, false);
  });

  it('calls next() when user email is in the allowlist', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com,other@cards402.com';
    const mw = freshMiddleware();
    const { statusCode, nextCalled } = runMiddleware(mw, {
      id: 'u1',
      email: 'ops@cards402.com',
    });
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
  });

  it('matches email case-insensitively', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'Ops@Cards402.Com';
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'ops@cards402.com' });
    assert.equal(nextCalled, true);
  });

  it('trims whitespace around env entries', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = '  ops@cards402.com  ,  other@cards402.com  ';
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'other@cards402.com' });
    assert.equal(nextCalled, true);
  });

  it('re-reads env on every call (supports live rotation)', () => {
    const mw = freshMiddleware();
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'first@cards402.com';
    assert.equal(runMiddleware(mw, { id: 'u1', email: 'first@cards402.com' }).nextCalled, true);
    // Rotate without re-requiring the module.
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'second@cards402.com';
    assert.equal(
      runMiddleware(mw, { id: 'u1', email: 'first@cards402.com' }).nextCalled,
      false,
      'first@ should be rejected after rotation',
    );
    assert.equal(
      runMiddleware(mw, { id: 'u1', email: 'second@cards402.com' }).nextCalled,
      true,
      'second@ should be accepted after rotation',
    );
  });
});
