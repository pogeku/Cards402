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

// ── F1-card-reveal: bizEvent observability on every authorization decision ─
//
// Pre-fix, denied attempts (no user, missing email, env not configured,
// not in allowlist) returned 401/403 silently — zero signal for forensics
// or alerting. A hostile operator probing the endpoint left no trace.
// Post-fix, every branch emits a bizEvent with the specific reason plus
// actor email / IP / user-agent so the dashboard alert engine can surface
// spikes in real time. Successful authorization also emits a bizEvent so
// every reveal attempt has a signal regardless of downstream route failure.

describe('F1-card-reveal: bizEvent observability', () => {
  let origEnv;
  let events;
  let origEvent;

  function runWithReq(middleware, req) {
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

  beforeEach(() => {
    origEnv = process.env.CARDS402_CARD_REVEAL_EMAILS;
    // Stub the logger.event() function. The middleware captures
    // `const { event: bizEvent } = require('../lib/logger')` at module
    // LOAD time, so the stub has to be installed before freshMiddleware().
    const logger = require('../../src/lib/logger');
    origEvent = logger.event;
    events = [];
    logger.event = (name, fields) => events.push({ name, fields });
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    else process.env.CARDS402_CARD_REVEAL_EMAILS = origEnv;
    const logger = require('../../src/lib/logger');
    logger.event = origEvent;
  });

  it('emits card_reveal.denied with reason=no_user when req.user is missing', () => {
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    runWithReq(mw, {
      user: null,
      ip: '10.0.0.1',
      headers: { 'user-agent': 'curl/8.0' },
    });
    const denied = events.find((e) => e.name === 'card_reveal.denied');
    assert.ok(denied, 'expected card_reveal.denied event');
    assert.equal(denied.fields.reason, 'no_user');
    assert.equal(denied.fields.actor_email, null);
    assert.equal(denied.fields.ip, '10.0.0.1');
    assert.equal(denied.fields.user_agent, 'curl/8.0');
  });

  it('emits card_reveal.denied with reason=missing_email when email is empty', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    runWithReq(mw, {
      user: { id: 'u1', email: '' },
      ip: '10.0.0.2',
      headers: { 'user-agent': 'curl/8.0' },
    });
    const denied = events.find((e) => e.name === 'card_reveal.denied');
    assert.ok(denied);
    assert.equal(denied.fields.reason, 'missing_email');
    assert.equal(denied.fields.actor_user_id, 'u1');
    assert.equal(denied.fields.actor_email, null);
  });

  it('emits card_reveal.denied with reason=env_not_configured when allowlist is empty', () => {
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    runWithReq(mw, {
      user: { id: 'u1', email: 'ops@cards402.com' },
      ip: '10.0.0.3',
      headers: {},
    });
    const denied = events.find((e) => e.name === 'card_reveal.denied');
    assert.ok(denied);
    assert.equal(denied.fields.reason, 'env_not_configured');
    assert.equal(denied.fields.actor_email, 'ops@cards402.com');
    assert.equal(denied.fields.user_agent, null);
  });

  it('emits card_reveal.denied with reason=not_in_allowlist when email is off-list', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    runWithReq(mw, {
      user: { id: 'u1', email: 'attacker@evil.com' },
      ip: '10.0.0.4',
      headers: { 'user-agent': 'python-requests/2.31' },
    });
    const denied = events.find((e) => e.name === 'card_reveal.denied');
    assert.ok(denied);
    assert.equal(denied.fields.reason, 'not_in_allowlist');
    assert.equal(denied.fields.actor_email, 'attacker@evil.com');
    assert.equal(denied.fields.user_agent, 'python-requests/2.31');
  });

  it('emits card_reveal.allowed on successful authorization', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const { nextCalled } = runWithReq(mw, {
      user: { id: 'u1', email: 'ops@cards402.com' },
      ip: '10.0.0.5',
      headers: { 'user-agent': 'chrome/120' },
    });
    assert.equal(nextCalled, true);
    const allowed = events.find((e) => e.name === 'card_reveal.allowed');
    assert.ok(allowed, 'expected card_reveal.allowed event on success');
    assert.equal(allowed.fields.actor_email, 'ops@cards402.com');
    assert.equal(allowed.fields.actor_user_id, 'u1');
    assert.equal(allowed.fields.ip, '10.0.0.5');
    assert.equal(allowed.fields.user_agent, 'chrome/120');
    // Critical: the allowed path does NOT emit a denied event too.
    assert.equal(
      events.filter((e) => e.name === 'card_reveal.denied').length,
      0,
      'allowed branch must not emit a denied event',
    );
  });

  it('coerces array-valued user-agent header to its first element', () => {
    // Same defensive pattern as audit.js — a double-set header from a
    // misconfigured proxy returns a string[] in Node's http parser.
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    runWithReq(mw, {
      user: { id: 'u1', email: 'ops@cards402.com' },
      ip: '10.0.0.6',
      headers: { 'user-agent': ['agent-a', 'agent-b'] },
    });
    const denied = events.find((e) => e.name === 'card_reveal.denied');
    assert.ok(denied);
    assert.equal(denied.fields.user_agent, 'agent-a');
  });

  it('falls back to X-Forwarded-For when req.ip is absent', () => {
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    runWithReq(mw, {
      user: { id: 'u1', email: 'ops@cards402.com' },
      // req.ip missing — middleware should fall through to the header.
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    const denied = events.find((e) => e.name === 'card_reveal.denied');
    assert.ok(denied);
    assert.equal(denied.fields.ip, '198.51.100.7');
  });
});

// ── F3-card-reveal: bizEvent failures must not alter the auth verdict ──────
//
// Observability is strictly secondary to the gate's correctness. A
// downstream event-bus subscriber that throws, a full stdout buffer, or
// any other logger failure must NOT flip a 403 into a 500 — that would
// give an attacker more info than a plain authorization denial and could
// mask the underlying cause of a real reveal attempt.

describe('F3-card-reveal: bizEvent failure does not alter auth verdict', () => {
  let origEnv;
  let origEvent;

  beforeEach(() => {
    origEnv = process.env.CARDS402_CARD_REVEAL_EMAILS;
    const logger = require('../../src/lib/logger');
    origEvent = logger.event;
    // Install a throwing stub — every bizEvent call blows up.
    logger.event = () => {
      throw new Error('simulated logger failure');
    };
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    else process.env.CARDS402_CARD_REVEAL_EMAILS = origEnv;
    const logger = require('../../src/lib/logger');
    logger.event = origEvent;
  });

  it('still returns 403 on denied branch even though bizEvent throws', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const req = { user: { id: 'u1', email: 'other@evil.com' }, ip: '10.0.0.1', headers: {} };
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
    // Must not throw.
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'forbidden');
    assert.equal(nextCalled, false);
  });

  it('still calls next() on allowed branch even though bizEvent throws', () => {
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'ops@cards402.com';
    const mw = freshMiddleware();
    const req = { user: { id: 'u1', email: 'ops@cards402.com' }, ip: '10.0.0.1', headers: {} };
    let statusCode = null;
    const res = {
      status(c) {
        statusCode = c;
        return this;
      },
      json() {
        return this;
      },
    };
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
  });

  it('still returns 401 on missing user even though bizEvent throws', () => {
    delete process.env.CARDS402_CARD_REVEAL_EMAILS;
    const mw = freshMiddleware();
    const req = { user: null, headers: {} };
    let statusCode = null;
    const res = {
      status(c) {
        statusCode = c;
        return this;
      },
      json() {
        return this;
      },
    };
    mw(req, res, () => {});
    assert.equal(statusCode, 401);
  });
});
