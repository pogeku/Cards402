// Unit tests for backend/src/middleware/requireInternal.
//
// Gates every /internal/* endpoint. Sister-middleware to
// requireCardReveal (audited in the same session) — same shape of
// tests, same fail-closed discipline. Previously zero direct coverage.
//
// These tests lock in the current contract AND include explicit
// regression guards for the classic email-suffix bypass attempts an
// auditor would try:
//   - double-@ email "a@b@cards402.com"
//   - substring injection "a@cards402.comevil.com"
//   - subdomain "a@bar.cards402.com"
//   - trailing dot "a@cards402.com."
//   - case variations
// auth.js's regex rejects some of these at email validation time, but
// the middleware should still fail closed on its own so that a future
// bypass in the upstream validator doesn't immediately escalate.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const MIDDLEWARE_PATH = require.resolve('../../src/middleware/requireInternal');

function freshMiddleware() {
  delete require.cache[MIDDLEWARE_PATH];
  return require('../../src/middleware/requireInternal');
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

describe('requireInternal — auth gate', () => {
  let origEnv;

  beforeEach(() => {
    origEnv = process.env.INTERNAL_EMAILS;
    delete process.env.INTERNAL_EMAILS;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.INTERNAL_EMAILS;
    else process.env.INTERNAL_EMAILS = origEnv;
  });

  it('401 when req.user is missing', () => {
    const mw = freshMiddleware();
    const { statusCode, body, nextCalled } = runMiddleware(mw, null);
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user has no email (F1 defence)', () => {
    const mw = freshMiddleware();
    const { statusCode, body, nextCalled } = runMiddleware(mw, { id: 'u1' });
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user.email is empty string', () => {
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: '' });
    assert.equal(statusCode, 401);
  });

  it('401 when req.user.email is a non-string type', () => {
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 42 });
    assert.equal(statusCode, 401);
  });
});

describe('requireInternal — domain allow', () => {
  let origEnv;

  beforeEach(() => {
    origEnv = process.env.INTERNAL_EMAILS;
    delete process.env.INTERNAL_EMAILS;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.INTERNAL_EMAILS;
    else process.env.INTERNAL_EMAILS = origEnv;
  });

  it('allows any @cards402.com email', () => {
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'ops@cards402.com' });
    assert.equal(nextCalled, true);
  });

  it('matches the @cards402.com domain case-insensitively', () => {
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'OPS@CARDS402.COM' });
    assert.equal(nextCalled, true);
  });

  it('rejects non-@cards402.com emails when INTERNAL_EMAILS is unset', () => {
    const mw = freshMiddleware();
    const { statusCode, body } = runMiddleware(mw, { id: 'u1', email: 'ops@gmail.com' });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'forbidden');
  });
});

describe('requireInternal — domain suffix bypass guards', () => {
  // These are the classic email-suffix auth bypasses an auditor would
  // probe. auth.js's regex rejects most of them at email validation
  // time, but the middleware should still fail closed on its own.

  it('rejects substring injection: a@cards402.comevil.com', () => {
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 'a@cards402.comevil.com' });
    assert.equal(statusCode, 403);
  });

  it('rejects subdomain: a@bar.cards402.com', () => {
    // endsWith('@cards402.com') on 'a@bar.cards402.com' — last 14
    // chars are 'r.cards402.com', doesn't match @cards402.com.
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 'a@bar.cards402.com' });
    assert.equal(statusCode, 403);
  });

  it('rejects trailing dot: a@cards402.com.', () => {
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 'a@cards402.com.' });
    assert.equal(statusCode, 403);
  });

  it('rejects lookalike tld: a@cards402.co', () => {
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 'a@cards402.co' });
    assert.equal(statusCode, 403);
  });

  it('rejects prefix injection: xcards402.com as suffix', () => {
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 'a@xcards402.com' });
    assert.equal(statusCode, 403);
  });
});

describe('requireInternal — INTERNAL_EMAILS allowlist', () => {
  let origEnv;

  beforeEach(() => {
    origEnv = process.env.INTERNAL_EMAILS;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.INTERNAL_EMAILS;
    else process.env.INTERNAL_EMAILS = origEnv;
  });

  it('allows a specific external email when listed in INTERNAL_EMAILS', () => {
    process.env.INTERNAL_EMAILS = 'consultant@partner.io';
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'consultant@partner.io' });
    assert.equal(nextCalled, true);
  });

  it('still rejects other external emails when INTERNAL_EMAILS is set', () => {
    process.env.INTERNAL_EMAILS = 'consultant@partner.io';
    const mw = freshMiddleware();
    const { statusCode } = runMiddleware(mw, { id: 'u1', email: 'other@partner.io' });
    assert.equal(statusCode, 403);
  });

  it('matches INTERNAL_EMAILS entries case-insensitively', () => {
    process.env.INTERNAL_EMAILS = 'Consultant@Partner.io';
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'consultant@partner.io' });
    assert.equal(nextCalled, true);
  });

  it('trims whitespace around INTERNAL_EMAILS entries', () => {
    process.env.INTERNAL_EMAILS = '  a@partner.io  ,  b@partner.io  ';
    const mw = freshMiddleware();
    const { nextCalled } = runMiddleware(mw, { id: 'u1', email: 'b@partner.io' });
    assert.equal(nextCalled, true);
  });

  it('re-reads env on every call (supports live rotation)', () => {
    const mw = freshMiddleware();
    process.env.INTERNAL_EMAILS = 'first@partner.io';
    assert.equal(runMiddleware(mw, { id: 'u1', email: 'first@partner.io' }).nextCalled, true);
    process.env.INTERNAL_EMAILS = 'second@partner.io';
    assert.equal(
      runMiddleware(mw, { id: 'u1', email: 'first@partner.io' }).nextCalled,
      false,
      'first@ should be rejected after rotation',
    );
    assert.equal(
      runMiddleware(mw, { id: 'u1', email: 'second@partner.io' }).nextCalled,
      true,
      'second@ should be accepted after rotation',
    );
  });
});
