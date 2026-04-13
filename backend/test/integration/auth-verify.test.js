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
