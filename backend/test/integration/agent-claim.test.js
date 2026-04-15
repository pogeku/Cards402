// Integration tests for POST /v1/agent/claim — the unauthenticated
// one-shot endpoint that trades a claim code for the real api_key.
//
// Before the adversarial audit (2026-04-15) there were NO tests for
// this endpoint at all. It's one of the highest-impact surfaces in
// the product (unauth, returns live credentials) and this file pins
// the core contract:
//
//   - happy path: valid code → 200 with api_key + webhook_secret
//   - invalid code → 401 invalid_claim
//   - expired code → 401 invalid_claim (same bucket — no probing)
//   - used code → 401 invalid_claim (same bucket)
//   - single-use enforcement: second redeem returns 401
//
// Plus the adversarial-audit regression guards:
//
//   F1 — decrypt failure rolls back the mark-used txn. Previously a
//        malformed/wrongly-sealed payload would burn the claim on
//        the first attempt (txn committed before decrypt); now the
//        decrypt runs INSIDE the txn, so a throw aborts the rollback
//        and the operator can fix the payload and retry the claim.
//
//   F2 — error response doesn't echo "CARDS402_SECRET_BOX_KEY" to
//        the unauth'd caller. Server-side log gets the real cause,
//        wire response is a generic "claim_decrypt_failed".

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { request, db, resetDb, createTestKey } = require('../helpers/app');
const { hashClaimCode } = require('../../src/lib/claim-hash');

// ── Helpers ────────────────────────────────────────────────────────────

async function seedClaim({ code, apiKeyId = null, sealedPayload, expiresInMin = 10 } = {}) {
  // If no apiKeyId is provided, mint a fresh test api key and attach
  // the claim to it so the post-redemption SELECT api_keys + audit
  // path has a real row to hit.
  let keyId = apiKeyId;
  if (!keyId) {
    const k = await createTestKey({ label: 'claim-test-agent' });
    keyId = k.id;
  }
  const claimId = uuidv4();
  const expiresAt = new Date(Date.now() + expiresInMin * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO agent_claims (id, code, api_key_id, sealed_payload, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(claimId, hashClaimCode(code), keyId, sealedPayload, expiresAt);
  return { claimId, apiKeyId: keyId };
}

// In test env (no CARDS402_SECRET_BOX_KEY set) secret-box.seal() is a
// plaintext pass-through — the returned value is literally the input
// string. So a valid sealed payload for these tests is just the
// plaintext JSON.
function passthroughSealed(obj) {
  return JSON.stringify(obj);
}

// ── Happy path ─────────────────────────────────────────────────────────

describe('POST /v1/agent/claim — happy path', () => {
  beforeEach(() => resetDb());

  it('returns api_key + webhook_secret for a valid code', async () => {
    const code = 'c402_happy_path_0123456789abcdef';
    const { apiKeyId } = await seedClaim({
      code,
      sealedPayload: passthroughSealed({
        api_key: 'cards402_fake_key_for_test',
        webhook_secret: 'whsec_fake_for_test',
      }),
    });

    const res = await request.post('/v1/agent/claim').send({ code });

    assert.equal(res.status, 200);
    assert.equal(res.body.api_key, 'cards402_fake_key_for_test');
    assert.equal(res.body.webhook_secret, 'whsec_fake_for_test');
    assert.equal(res.body.api_key_id, apiKeyId);
  });

  it('marks the claim used and wipes sealed_payload after a successful redeem', async () => {
    const code = 'c402_wipe_payload_0123456789abcdef';
    const { claimId } = await seedClaim({
      code,
      sealedPayload: passthroughSealed({ api_key: 'cards402_x', webhook_secret: 'whsec_x' }),
    });
    await request.post('/v1/agent/claim').send({ code });

    const row = db
      .prepare(`SELECT used_at, sealed_payload FROM agent_claims WHERE id = ?`)
      .get(claimId);
    assert.ok(row.used_at, 'used_at must be set after redemption');
    assert.equal(row.sealed_payload, '', 'sealed_payload must be wiped after redemption');
  });
});

// ── Invalid / expired / used buckets ──────────────────────────────────

describe('POST /v1/agent/claim — rejection buckets', () => {
  beforeEach(() => resetDb());

  it('rejects a completely unknown code with 401 invalid_claim', async () => {
    const res = await request.post('/v1/agent/claim').send({ code: 'c402_does_not_exist' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_claim');
  });

  it('rejects an expired code with 401 invalid_claim (same generic error)', async () => {
    const code = 'c402_expired_0123456789abcdef';
    await seedClaim({
      code,
      sealedPayload: passthroughSealed({ api_key: 'x', webhook_secret: 'x' }),
      expiresInMin: -5, // already expired
    });
    const res = await request.post('/v1/agent/claim').send({ code });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_claim');
  });

  it('rejects a second redemption with 401 invalid_claim', async () => {
    const code = 'c402_single_use_0123456789abcdef';
    await seedClaim({
      code,
      sealedPayload: passthroughSealed({ api_key: 'x', webhook_secret: 'x' }),
    });
    const first = await request.post('/v1/agent/claim').send({ code });
    assert.equal(first.status, 200);
    const second = await request.post('/v1/agent/claim').send({ code });
    assert.equal(second.status, 401);
    assert.equal(second.body.error, 'invalid_claim');
  });

  it('rejects missing code with 400 missing_code', async () => {
    const res = await request.post('/v1/agent/claim').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_code');
  });

  it('rejects non-string code with 400 missing_code', async () => {
    const res = await request.post('/v1/agent/claim').send({ code: ['c402_x'] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_code');
  });
});

// ── F1-claim: decrypt failure must NOT burn the claim ────────────────
//
// The primary adversarial-audit fix. Previously the flow was:
//
//   1. mark the row used + wipe payload  (commits)
//   2. decrypt the pre-wipe payload      (can throw)
//
// A throw at step 2 returned 500 but left the row used, so the agent's
// retry got 401 invalid_claim — the claim was burned by a transient
// server-side error (missing key, corrupt blob, rotation). Post-fix,
// decrypt runs INSIDE the txn so a throw rolls the mark-used back
// and the claim is still valid for a retry after the operator fixes
// the underlying cause.

describe('POST /v1/agent/claim — F1 decrypt failure rollback', () => {
  beforeEach(() => resetDb());

  it('returns 500 claim_decrypt_failed on malformed sealed_payload', async () => {
    const code = 'c402_decrypt_fail_0123456789abcdef';
    // A blob starting with `enc:` forces secret-box.open() into the
    // decrypt path. In test env CARDS402_SECRET_BOX_KEY is unset so
    // open() throws 'CARDS402_SECRET_BOX_KEY not set, cannot decrypt'.
    // The malformed structure ensures the throw happens even if the
    // key existed.
    await seedClaim({ code, sealedPayload: 'enc:aa:bb:cc' });

    const res = await request.post('/v1/agent/claim').send({ code });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'claim_decrypt_failed');
  });

  it('F2: the decrypt-failed response does NOT leak the env var name', async () => {
    const code = 'c402_f2_no_leak_0123456789abcdef';
    await seedClaim({ code, sealedPayload: 'enc:aa:bb:cc' });

    const res = await request.post('/v1/agent/claim').send({ code });
    assert.equal(res.status, 500);
    // Pre-fix the response included "Server misconfigured:
    // CARDS402_SECRET_BOX_KEY not set." — directly echoing the env
    // var name to an unauthenticated caller.
    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(
      serialized,
      /CARDS402_SECRET_BOX_KEY/,
      'wire response must not echo the env var name',
    );
    assert.doesNotMatch(serialized, /misconfigured/i, 'no hint at the internal cause');
  });

  it('does NOT mark the claim used when decryption fails — retry stays valid (F1)', async () => {
    const code = 'c402_retry_works_0123456789abcdef';
    const { claimId } = await seedClaim({
      code,
      // First seed with a malformed blob — this triggers the rollback
      // path on the first /v1/agent/claim attempt.
      sealedPayload: 'enc:aa:bb:cc',
    });

    const first = await request.post('/v1/agent/claim').send({ code });
    assert.equal(first.status, 500);

    // The row must NOT be marked used — the transaction rolled back.
    // Pre-fix, `used_at` would have been set here and the retry below
    // would return 401 invalid_claim even though the operator has
    // since fixed the payload.
    const row = db
      .prepare(`SELECT used_at, sealed_payload FROM agent_claims WHERE id = ?`)
      .get(claimId);
    assert.equal(row.used_at, null, 'used_at must remain null after rolled-back decrypt');
    assert.equal(
      row.sealed_payload,
      'enc:aa:bb:cc',
      'sealed_payload must remain intact after rolled-back decrypt',
    );

    // Simulate the operator fixing the payload (e.g. restoring the
    // correct key or re-sealing) and retry. The claim is still valid
    // so the second attempt should succeed.
    db.prepare(`UPDATE agent_claims SET sealed_payload = ? WHERE id = ?`).run(
      passthroughSealed({
        api_key: 'cards402_rescued_after_fix',
        webhook_secret: 'whsec_rescued',
      }),
      claimId,
    );
    const retry = await request.post('/v1/agent/claim').send({ code });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.api_key, 'cards402_rescued_after_fix');
  });
});
