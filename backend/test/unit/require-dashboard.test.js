// Unit tests for src/middleware/requireDashboard.js.
//
// Before the 2026-04-15 adversarial audit there was ZERO direct
// coverage for this middleware. This file locks in:
//
//   F1-requireDashboard: fail closed to 401 when req.user is missing
//                        or malformed, rather than crashing on
//                        undefined.id and cascading to 500
//
//   F2-requireDashboard: deterministic primary-dashboard selection
//                        when a user has multiple rows (the schema
//                        has no UNIQUE(user_id) constraint), plus a
//                        loud warn so ops can clean up duplicates

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb } = require('../helpers/app');

const requireDashboard = require('../../src/middleware/requireDashboard');

function runMiddleware(req) {
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
  requireDashboard(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, body, nextCalled, req };
}

function seedUser(email = 'owner@cards402.com', role = 'owner') {
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, email, role) VALUES (?, ?, ?)`).run(id, email, role);
  return id;
}

function seedDashboard(userId, { name = 'Primary', createdAt } = {}) {
  const id = uuidv4();
  if (createdAt) {
    db.prepare(`INSERT INTO dashboards (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`).run(
      id,
      userId,
      name,
      createdAt,
    );
  } else {
    db.prepare(`INSERT INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`).run(id, userId, name);
  }
  return id;
}

// ── F1-requireDashboard: missing req.user → 401 (not 500) ───────────────────

describe('F1-requireDashboard: missing req.user guard', () => {
  beforeEach(() => resetDb());

  it('401 when req.user is missing entirely', () => {
    const { statusCode, body, nextCalled } = runMiddleware({});
    assert.equal(statusCode, 401);
    assert.equal(body.error, 'unauthenticated');
    assert.equal(nextCalled, false);
  });

  it('401 when req.user is null', () => {
    const { statusCode } = runMiddleware({ user: null });
    assert.equal(statusCode, 401);
  });

  it('401 when req.user.id is missing', () => {
    const { statusCode, nextCalled } = runMiddleware({ user: {} });
    assert.equal(statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it('401 when req.user.id is not a string', () => {
    // Pre-fix this crashed with a cryptic SQL bind error.
    const { statusCode } = runMiddleware({ user: { id: 42 } });
    assert.equal(statusCode, 401);
  });

  it('401 when req.user.id is the empty string', () => {
    const { statusCode } = runMiddleware({ user: { id: '' } });
    assert.equal(statusCode, 401);
  });
});

// ── baseline: happy path + no-dashboard path ────────────────────────────────

describe('requireDashboard — happy path', () => {
  beforeEach(() => resetDb());

  it('attaches req.dashboard and calls next() when a single dashboard exists', () => {
    const userId = seedUser();
    const dashId = seedDashboard(userId, { name: 'Primary' });
    const req = { user: { id: userId } };
    const { statusCode, nextCalled } = runMiddleware(req);
    assert.equal(statusCode, null);
    assert.equal(nextCalled, true);
    assert.equal(req.dashboard.id, dashId);
    assert.equal(req.dashboard.name, 'Primary');
  });

  it('404 no_dashboard when the user has no dashboard', () => {
    const userId = seedUser();
    const { statusCode, body, nextCalled } = runMiddleware({ user: { id: userId } });
    assert.equal(statusCode, 404);
    assert.equal(body.error, 'no_dashboard');
    assert.equal(nextCalled, false);
  });

  it('404 when req.user.id points at a non-existent user', () => {
    const { statusCode, body } = runMiddleware({ user: { id: 'ghost-user-id' } });
    assert.equal(statusCode, 404);
    assert.equal(body.error, 'no_dashboard');
  });
});

// ── F2-requireDashboard: deterministic duplicate handling ───────────────────

describe('F2-requireDashboard: deterministic selection with duplicates', () => {
  let origWarn;
  let warns;

  beforeEach(() => {
    resetDb();
    warns = [];
    origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  it('picks the earliest-created dashboard when multiple exist', () => {
    const userId = seedUser();
    // Seed three dashboards with distinct created_at values. The
    // earliest (2026-01-01) should be returned regardless of insert order.
    seedDashboard(userId, { name: 'Second', createdAt: '2026-03-01 00:00:00' });
    seedDashboard(userId, { name: 'Primary', createdAt: '2026-01-01 00:00:00' });
    seedDashboard(userId, { name: 'Third', createdAt: '2026-06-01 00:00:00' });
    const req = { user: { id: userId } };
    const { nextCalled } = runMiddleware(req);
    assert.equal(nextCalled, true);
    assert.equal(req.dashboard.name, 'Primary');
  });

  it('logs a warn pointing at the chosen dashboard when duplicates are present', () => {
    const userId = seedUser();
    seedDashboard(userId, { name: 'A', createdAt: '2026-01-01 00:00:00' });
    seedDashboard(userId, { name: 'B', createdAt: '2026-02-01 00:00:00' });
    const req = { user: { id: userId } };
    runMiddleware(req);
    const dupWarn = warns.find((w) => /multiple dashboard rows/.test(w));
    assert.ok(dupWarn, `expected duplicate warn, got: ${JSON.stringify(warns)}`);
    assert.match(dupWarn, new RegExp(userId));
    assert.match(dupWarn, new RegExp(req.dashboard.id));
  });

  it('does NOT warn for the single-dashboard common case', () => {
    const userId = seedUser();
    seedDashboard(userId);
    runMiddleware({ user: { id: userId } });
    assert.equal(
      warns.filter((w) => /multiple dashboard rows/.test(w)).length,
      0,
      'single-dashboard case must not trigger the duplicate warn',
    );
  });

  it('returns the same dashboard across repeated calls (determinism)', () => {
    const userId = seedUser();
    seedDashboard(userId, { name: 'A', createdAt: '2026-01-01 00:00:00' });
    seedDashboard(userId, { name: 'B', createdAt: '2026-02-01 00:00:00' });
    seedDashboard(userId, { name: 'C', createdAt: '2026-03-01 00:00:00' });
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const req = { user: { id: userId } };
      runMiddleware(req);
      ids.add(req.dashboard.id);
    }
    assert.equal(ids.size, 1, 'repeated calls must return the same dashboard id');
  });
});
