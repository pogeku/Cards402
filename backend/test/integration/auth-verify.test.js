// Adversarial audit F3 — /auth/verify brute-force protection.
//
// Two layers:
//   1. Per-IP express-rate-limit (20 attempts / 10 min). Not exercised here
//      because the limiter is shared process-wide and hard to reset cleanly
//      between tests without reaching into internals. The per-email lockout
//      below is the tighter of the two and is the one that actually stops
//      a distributed guessing campaign.
//   2. Per-email failed_attempts counter on auth_codes. After 5 bad
//      verifies, all active codes for the email are invalidated.
//
// Before F3, /auth/verify had neither — a 6-digit code (10^6 keyspace)
// could be guessed at wire speed.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { request, db, resetDb } = require('../helpers/app');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function seedCode(email, code, { expiresInMin = 15 } = {}) {
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + expiresInMin * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO auth_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, ?)`).run(
    id,
    email,
    hashToken(code),
    expiresAt,
  );
  return id;
}

describe('POST /auth/verify — brute-force protection (audit F3)', () => {
  beforeEach(() => resetDb());

  it('rejects an incorrect code with 401 invalid_code', async () => {
    const email = 'locktest1@example.com';
    seedCode(email, '123456');
    const res = await request.post('/auth/verify').send({ email, code: '000000' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_code');
  });

  it('increments failed_attempts on every active code on a bad verify', async () => {
    const email = 'locktest2@example.com';
    seedCode(email, '111111');
    await request.post('/auth/verify').send({ email, code: '000001' });
    await request.post('/auth/verify').send({ email, code: '000002' });
    const row = db.prepare(`SELECT failed_attempts FROM auth_codes WHERE email = ?`).get(email);
    assert.equal(row.failed_attempts, 2);
  });

  it('locks out the email after 5 failed attempts and marks every code used', async () => {
    const email = 'locktest3@example.com';
    // Two concurrent codes for the same email — after lockout BOTH must
    // be marked used so the attacker can't just guess against the other one.
    seedCode(email, '111111');
    seedCode(email, '222222');

    // First 4 bad tries each return 401 invalid_code but tick the counter.
    for (let i = 0; i < 4; i++) {
      const r = await request.post('/auth/verify').send({ email, code: '999999' });
      assert.equal(r.status, 401);
    }

    // 5th bad try trips the threshold → lockout → 429 too_many_attempts.
    const locked = await request.post('/auth/verify').send({ email, code: '999999' });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'too_many_attempts');

    // Both codes should be marked used (used_at not null) — even the one
    // the attacker wasn't guessing against. The correct guess after lockout
    // must not succeed either.
    const rows = db
      .prepare(`SELECT used_at FROM auth_codes WHERE email = ? ORDER BY created_at`)
      .all(email);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.used_at, 'every code should be marked used after lockout');
    }

    // Correct code after lockout — still fails because the row is used.
    const afterLockout = await request.post('/auth/verify').send({ email, code: '111111' });
    assert.equal(afterLockout.status, 401);
  });

  it('a correct code before the lockout threshold still works', async () => {
    const email = 'locktest4@example.com';
    seedCode(email, '654321');
    // Three bad tries, then the right code — still within the 5-limit budget.
    await request.post('/auth/verify').send({ email, code: '000000' });
    await request.post('/auth/verify').send({ email, code: '000001' });
    await request.post('/auth/verify').send({ email, code: '000002' });
    const res = await request.post('/auth/verify').send({ email, code: '654321' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });
});

// ── F1-auth (2026-04-15): body shape + field typing ─────────────────────
//
// Before the guards, requests with a missing or malformed body crashed
// the destructure with 500. Same class of bug as F3-orders in an
// earlier cycle. These tests pin the 400 invalid_request contract.

describe('POST /auth/login — F1 body shape guard', () => {
  beforeEach(() => resetDb());

  it('returns 400 invalid_request when body is an array', async () => {
    const res = await request.post('/auth/login').send([{ email: 'a@b.com' }]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
  });

  it('returns 400 invalid_email when email field is missing', async () => {
    // Legacy guard — empty object passes body-shape check but fails
    // the email-typeof check. Regression guard for the refactor order.
    const res = await request.post('/auth/login').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_email');
  });

  it('returns 400 invalid_email when email is an array', async () => {
    const res = await request.post('/auth/login').send({ email: ['a@b.com'] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_email');
  });
});

describe('POST /auth/verify — F1 body shape guard', () => {
  beforeEach(() => resetDb());

  it('returns 400 invalid_request when body is an array', async () => {
    const res = await request.post('/auth/verify').send([{ email: 'a@b.com', code: '123456' }]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
  });

  it('returns 400 missing_fields when email is an array (strict typeof)', async () => {
    // Before F1 the existing check was `if (!email || !code)` with no
    // typeof. An array email is truthy so it slipped through, then
    // normalizeEmail(email).trim() crashed because arrays don't have
    // .trim() → 500.
    const res = await request.post('/auth/verify').send({ email: ['a@b.com'], code: '123456' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_fields');
  });

  it('returns 400 missing_fields when code is a number (strict typeof)', async () => {
    const res = await request.post('/auth/verify').send({ email: 'a@b.com', code: 123456 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_fields');
  });
});

// ── F3-auth (2026-04-15): owner-bootstrap atomicity ────────────────────
//
// The user find/create block now lives inside a db.transaction. This
// test can't drive two concurrent requests (node:test + supertest +
// better-sqlite3 are all sync), but it can pin the happy-path
// invariant: a fresh verify creates exactly one user with role='owner'
// and the transaction leaves the DB in a consistent state.

describe('POST /auth/verify — F3 bootstrap owner creation', () => {
  beforeEach(() => resetDb());

  it('first successful verify creates exactly one user with role=owner', async () => {
    const email = 'first-owner@example.com';
    seedCode(email, '111111');
    const res = await request.post('/auth/verify').send({ email, code: '111111' });
    assert.equal(res.status, 200);

    const users = db.prepare(`SELECT id, email, role FROM users`).all();
    assert.equal(users.length, 1);
    assert.equal(users[0].email, email);
    assert.equal(users[0].role, 'owner');
  });

  it('second successful verify creates role=user (owner already exists)', async () => {
    seedCode('first@example.com', '111111');
    await request.post('/auth/verify').send({ email: 'first@example.com', code: '111111' });
    seedCode('second@example.com', '222222');
    const res = await request
      .post('/auth/verify')
      .send({ email: 'second@example.com', code: '222222' });
    assert.equal(res.status, 200);

    const users = db.prepare(`SELECT email, role FROM users ORDER BY created_at`).all();
    assert.equal(users.length, 2);
    assert.equal(users[0].role, 'owner');
    assert.equal(users[1].role, 'user');
  });

  it('repeated verify for an existing owner preserves role and creates no duplicate', async () => {
    // First verify — creates the owner.
    seedCode('repeat@example.com', '111111');
    await request.post('/auth/verify').send({ email: 'repeat@example.com', code: '111111' });
    // Second verify — same email with a fresh code. The transaction
    // must take the "user already exists" branch and not touch role.
    seedCode('repeat@example.com', '222222');
    const res = await request
      .post('/auth/verify')
      .send({ email: 'repeat@example.com', code: '222222' });
    assert.equal(res.status, 200);

    const users = db
      .prepare(`SELECT email, role FROM users WHERE email = ?`)
      .all('repeat@example.com');
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'owner');
  });
});
