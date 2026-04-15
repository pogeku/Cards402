// Integration tests for src/middleware/auth.js — the API key gate on
// every /v1/* route. Focuses on the rejection branches that older
// test files only covered at "missing" / "invalid" granularity.
//
// Exercises:
//   - Early-rejection paths (malformed headers, wrong prefix, wrong
//     length) that now bypass the DB scan entirely.
//   - Post-match gates: expired keys and suspended keys return the
//     specific error code, not a generic invalid_api_key.
//   - Regression guard for the "suspended agents could still read
//     orders" bug — before the 2026-04-14 audit, checkPolicy enforced
//     `suspended` at order-creation time but every other endpoint
//     (GET /v1/orders, /v1/usage, etc.) let suspended keys straight
//     through. Auth now blocks at the middleware layer.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { request, db, createTestKey, resetDb } = require('../helpers/app');

describe('auth middleware — /v1/* api key verification', () => {
  beforeEach(() => resetDb());

  // ── Missing / malformed header ───────────────────────────────────────────

  it('rejects a request with no X-Api-Key header', async () => {
    const res = await request.get('/v1/usage');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_api_key');
  });

  it('rejects a header that is not a valid cards402 key format', async () => {
    const res = await request.get('/v1/usage').set('X-Api-Key', 'not-a-real-key');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  it("rejects a key missing the 'cards402_' prefix", async () => {
    // Same overall length as a real key but wrong prefix. Should be
    // rejected by the early-return branch, NOT after a DB scan + bcrypt.
    const bogus = 'nope402_' + 'a'.repeat(48);
    const res = await request.get('/v1/usage').set('X-Api-Key', bogus);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  it('rejects a key shorter than the minimum length', async () => {
    // Short malformed keys used to trigger a full-table bcrypt scan
    // (DoS amplifier). Now early-rejected.
    const res = await request.get('/v1/usage').set('X-Api-Key', 'cards402_short');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  it('rejects a key longer than the maximum length', async () => {
    const res = await request.get('/v1/usage').set('X-Api-Key', 'cards402_' + 'a'.repeat(200));
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  // ── Valid key — baseline happy path ─────────────────────────────────────

  it('accepts a freshly-created key and exposes /v1/usage', async () => {
    const { key } = await createTestKey({ label: 'happy-path' });
    const res = await request.get('/v1/usage').set('X-Api-Key', key);
    assert.equal(res.status, 200);
    assert.ok(res.body.budget);
  });

  // ── Disabled / expired / suspended ──────────────────────────────────────

  it('rejects a key whose enabled flag is 0', async () => {
    const { key } = await createTestKey({ label: 'disabled', enabled: 0 });
    const res = await request.get('/v1/usage').set('X-Api-Key', key);
    assert.equal(res.status, 401);
    // Disabled keys aren't even included in the candidate SELECT, so
    // they come back as generic invalid_api_key — there's no
    // "api_key_disabled" leak.
    assert.equal(res.body.error, 'invalid_api_key');
  });

  it('rejects an expired key with api_key_expired', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { key } = await createTestKey({ label: 'expired', expiresAt: yesterday });
    const res = await request.get('/v1/usage').set('X-Api-Key', key);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'api_key_expired');
  });

  it('accepts a key whose expires_at is in the future', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { key } = await createTestKey({ label: 'future-expiry', expiresAt: tomorrow });
    const res = await request.get('/v1/usage').set('X-Api-Key', key);
    assert.equal(res.status, 200);
  });

  // ── The main regression guard: suspended keys were previously only
  //    blocked at order-creation time. Every read endpoint let them
  //    through. This batch confirms the middleware now blocks at /v1/*.

  it('rejects a suspended key with api_key_suspended on GET /v1/usage', async () => {
    const { key } = await createTestKey({ label: 'suspended-usage', suspended: 1 });
    const res = await request.get('/v1/usage').set('X-Api-Key', key);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'api_key_suspended');
  });

  it('rejects a suspended key with api_key_suspended on GET /v1/orders', async () => {
    const { key } = await createTestKey({ label: 'suspended-list', suspended: 1 });
    const res = await request.get('/v1/orders').set('X-Api-Key', key);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'api_key_suspended');
  });

  it('rejects a suspended key with api_key_suspended on POST /v1/orders', async () => {
    const { key } = await createTestKey({ label: 'suspended-create', suspended: 1 });
    const res = await request
      .post('/v1/orders')
      .set('X-Api-Key', key)
      .send({ amount_usdc: '10.00' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'api_key_suspended');
  });

  // ── Last-used tracking ──────────────────────────────────────────────────

  it('updates last_used_at after a successful auth', async () => {
    const { id, key } = await createTestKey({ label: 'last-used' });
    // Baseline: last_used_at might be null from the insert.
    const res = await request.get('/v1/usage').set('X-Api-Key', key);
    assert.equal(res.status, 200);
    const row = db.prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`).get(id);
    assert.ok(row.last_used_at, 'last_used_at should be set after a successful auth');
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('handles an X-Api-Key header that is an array (duplicated header)', async () => {
    // supertest sets duplicate headers via `.set`; the raw value comes
    // in as a string with both values joined. Either way the middleware
    // rejects it as malformed rather than throwing on .startsWith.
    const res = await request
      .get('/v1/usage')
      .set('X-Api-Key', 'cards402_' + 'a'.repeat(48))
      .set('X-Api-Key', 'cards402_' + 'b'.repeat(48));
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });

  // Adversarial audit F1-auth (2026-04-15): the pre-auth failure rate
  // limiter caps the bcrypt DoS amplifier. This test exercises the
  // pattern in isolation rather than against the production app, for
  // two reasons:
  //
  //   1. The production limiter reads its cap from the env at module
  //      load time, so mutating process.env mid-suite has no effect
  //      on the already-instantiated limiter.
  //   2. The integration test suite makes hundreds of intentionally-
  //      failing auth requests from 127.0.0.1 across many test files,
  //      so the production limit is raised in helpers/env.js — the
  //      cap is never tripped during normal runs.
  //
  // The minimal Express app here wires the same `rateLimit(...)` with
  // `skipSuccessfulRequests: true` at a low budget (3 failures) and
  // proves the pattern: failed responses count, successful ones do
  // not, and the 4th failure gets 429 instead of 401.
  it('authFailureLimiter: caps failed auths per IP, leaves successes alone (F1)', async () => {
    const express = require('express');
    const supertest = require('supertest');
    const { rateLimit } = require('express-rate-limit');

    const miniApp = express();

    const limiter = rateLimit({
      windowMs: 60 * 1000,
      limit: 3,
      skipSuccessfulRequests: true,
      // Fixed key — supertest hits localhost but the exact req.ip
      // can vary between supertest versions / Node builds. For this
      // test we want every request to land in the same bucket so we
      // can observe the counter directly.
      keyGenerator: () => 'unit-test-bucket',
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: 'too_many_failed_auth_attempts' }),
    });

    // Same order as app.js: limiter BEFORE the "auth" stage.
    miniApp.use('/v1', limiter);
    miniApp.use('/v1', (req, res, next) => {
      // Stub auth: success if X-Api-Key === 'valid', else 401.
      if (req.headers['x-api-key'] === 'valid') return next();
      res.status(401).json({ error: 'invalid_api_key' });
    });
    miniApp.get('/v1/usage', (_req, res) => res.json({ ok: true }));

    const miniRequest = supertest(miniApp);

    // 3 failures — all pass through to 401 because we're within budget.
    for (let i = 0; i < 3; i++) {
      const res = await miniRequest.get('/v1/usage').set('X-Api-Key', 'bad');
      assert.equal(res.status, 401, `attempt ${i + 1} should still reach auth`);
      assert.equal(res.body.error, 'invalid_api_key');
    }

    // 4th failure — limiter fires, 429 before reaching auth.
    const fourth = await miniRequest.get('/v1/usage').set('X-Api-Key', 'bad');
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error, 'too_many_failed_auth_attempts');

    // Successful auths must NOT consume budget. But we're already at
    // the cap, so sending a successful request would still be blocked
    // by the limiter CHECK at request start — skipSuccessfulRequests
    // controls incrementing, not gating. The limiter's semantics are:
    // "allow `limit` non-2xx responses per window; once the counter is
    // at `limit`, ALL further requests are 429'd until a successful
    // one brings the counter below the cap". So the right assertion
    // here is: once the budget is spent, even good keys are
    // temporarily blocked — that's the intended throttle effect.
    //
    // Instead: prove that in a FRESH limiter instance, a successful
    // request does NOT advance the counter.
    const miniApp2 = express();
    const limiter2 = rateLimit({
      windowMs: 60 * 1000,
      limit: 2,
      skipSuccessfulRequests: true,
      // Distinct bucket name from the first limiter so state doesn't leak.
      keyGenerator: () => 'unit-test-bucket-2',
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: 'too_many_failed_auth_attempts' }),
    });
    miniApp2.use('/v1', limiter2);
    miniApp2.use('/v1', (req, res, next) => {
      if (req.headers['x-api-key'] === 'valid') return next();
      res.status(401).json({ error: 'invalid_api_key' });
    });
    miniApp2.get('/v1/usage', (_req, res) => res.json({ ok: true }));
    const miniRequest2 = supertest(miniApp2);

    // 10 successful requests — budget is 2, but successes don't count.
    for (let i = 0; i < 10; i++) {
      const res = await miniRequest2.get('/v1/usage').set('X-Api-Key', 'valid');
      assert.equal(res.status, 200, `successful attempt ${i + 1} should not be blocked`);
    }
    // Now 2 failures — still OK because the budget hasn't been touched.
    for (let i = 0; i < 2; i++) {
      const res = await miniRequest2.get('/v1/usage').set('X-Api-Key', 'bad');
      assert.equal(res.status, 401);
    }
    // 3rd failure exhausts the budget.
    const blocked = await miniRequest2.get('/v1/usage').set('X-Api-Key', 'bad');
    assert.equal(blocked.status, 429);
  });

  it('does not accept bcrypt hash directly as the API key', async () => {
    const { id } = await createTestKey({ label: 'hash-as-key' });
    const row = db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(id);
    const res = await request.get('/v1/usage').set('X-Api-Key', row.key_hash);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });
});
