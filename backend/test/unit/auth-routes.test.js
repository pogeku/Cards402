// Unit tests for the auth.js route-level token extraction.
//
// F1-auth-routes (2026-04-16): /auth/logout and /auth/me extract the
// Bearer token themselves (they bypass the requireAuth middleware).
// Pre-fix they had the same two bugs that requireAuth had before
// F1/F2-requireAuth:
//   (1) Array-valued Authorization header → 500 (arrays have no .replace)
//   (2) Trailing whitespace preserved → session lookup misses → silent
//       logout failure or phantom 401 on /auth/me
//
// These tests exercise the routes end-to-end via supertest.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { request, db, createTestSession, resetDb } = require('../helpers/app');

// ── /auth/me ────────────────────────────────────────────────────────────────

describe('F1-auth-routes: /auth/me token handling', () => {
  let token;

  beforeEach(() => {
    resetDb();
    const session = createTestSession({ email: 'test@cards402.com' });
    token = session.token;
  });

  it('returns user for a valid Bearer token', async () => {
    const res = await request.get('/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, 'test@cards402.com');
  });

  it('accepts a token with trailing whitespace (F1 trim fix)', async () => {
    // Pre-fix: trailing space → hashToken mismatch → 401.
    const res = await request.get('/auth/me').set('Authorization', `Bearer ${token}  `);
    assert.equal(res.status, 200, 'trailing whitespace must not prevent session lookup');
    assert.equal(res.body.user.email, 'test@cards402.com');
  });

  it('accepts a token with trailing tab and newline', async () => {
    const res = await request.get('/auth/me').set('Authorization', `Bearer ${token}\t`);
    assert.equal(res.status, 200);
  });

  it('401 when Authorization header is missing', async () => {
    const res = await request.get('/auth/me');
    assert.equal(res.status, 401);
  });

  it('401 when token is invalid (not a real session)', async () => {
    const res = await request.get('/auth/me').set('Authorization', 'Bearer totallywrongtokenabc');
    assert.equal(res.status, 401);
  });

  it('does NOT crash on a non-string Authorization header value', async () => {
    // supertest doesn't let us set a numeric Authorization header, but
    // we can set a value that would NOT match the Bearer regex. The
    // important thing is it doesn't crash to 500.
    const res = await request.get('/auth/me').set('Authorization', 'NotBearer');
    assert.equal(res.status, 401);
  });

  it('401 when Bearer prefix is present but token is empty after strip', async () => {
    const res = await request.get('/auth/me').set('Authorization', 'Bearer   ');
    assert.equal(res.status, 401);
  });
});

// ── /auth/logout ────────────────────────────────────────────────────────────

describe('F1-auth-routes: /auth/logout token handling', () => {
  let token;

  beforeEach(() => {
    resetDb();
    const session = createTestSession({ email: 'test@cards402.com' });
    token = session.token;
  });

  it('deletes the session for a valid Bearer token', async () => {
    const res = await request.post('/auth/logout').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // Session should be gone.
    const meRes = await request.get('/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(meRes.status, 401, 'session should be deleted after logout');
  });

  it('deletes the session even when token has trailing whitespace (F1 trim fix)', async () => {
    // Pre-fix: trailing space → hashToken mismatch → session NOT deleted.
    const res = await request.post('/auth/logout').set('Authorization', `Bearer ${token} `);
    assert.equal(res.status, 200);
    // Verify the session is actually gone.
    const meRes = await request.get('/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(meRes.status, 401, 'session should be deleted despite trailing whitespace');
  });

  it('returns ok: true even when no Authorization header is sent (idempotent)', async () => {
    const res = await request.post('/auth/logout');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('does NOT crash on a non-Bearer Authorization value', async () => {
    const res = await request.post('/auth/logout').set('Authorization', 'Basic abc');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('does NOT crash when Bearer token is whitespace-only', async () => {
    const res = await request.post('/auth/logout').set('Authorization', 'Bearer   \t  ');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});
