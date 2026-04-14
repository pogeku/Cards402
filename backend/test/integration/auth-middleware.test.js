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

  it('does not accept bcrypt hash directly as the API key', async () => {
    const { id } = await createTestKey({ label: 'hash-as-key' });
    const row = db.prepare(`SELECT key_hash FROM api_keys WHERE id = ?`).get(id);
    const res = await request.get('/v1/usage').set('X-Api-Key', row.key_hash);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_api_key');
  });
});
