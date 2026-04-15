// Integration tests for POST /v1/agent/status — the lifecycle-state
// reporting endpoint that agents call during onboarding. Writes to
// api_keys.agent_state / wallet_public_key / agent_state_detail and
// fans out an 'agent_state' event over the in-process bus.
//
// Previously zero direct coverage. These tests lock in the 2026-04-15
// audit fixes and general contract:

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@stellar/stellar-sdk');
const { request, db, createTestKey, resetDb } = require('../helpers/app');

describe('POST /v1/agent/status', () => {
  /** @type {{ id: string, key: string }} */
  let testKey;

  beforeEach(async () => {
    resetDb();
    testKey = await createTestKey({ label: 'agent-status-key' });
  });

  it('401 without api key', async () => {
    const res = await request.post('/v1/agent/status').send({ state: 'initializing' });
    assert.equal(res.status, 401);
  });

  it('rejects an unknown state', async () => {
    const res = await request
      .post('/v1/agent/status')
      .set('X-Api-Key', testKey.key)
      .send({ state: 'minted' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_state');
  });

  it('rejects an empty body', async () => {
    const res = await request.post('/v1/agent/status').set('X-Api-Key', testKey.key).send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'nothing_to_update');
  });

  it('rejects a non-string detail', async () => {
    const res = await request
      .post('/v1/agent/status')
      .set('X-Api-Key', testKey.key)
      .send({ detail: { msg: 'oops' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_detail');
  });

  it('updates state and writes the DB row', async () => {
    const res = await request
      .post('/v1/agent/status')
      .set('X-Api-Key', testKey.key)
      .send({ state: 'funded' });
    assert.equal(res.status, 200);
    const row = /** @type {any} */ (
      db.prepare(`SELECT agent_state FROM api_keys WHERE id = ?`).get(testKey.id)
    );
    assert.equal(row.agent_state, 'funded');
  });

  // ── F2-agent-status: StrKey checksum enforcement ─────────────────────────
  //
  // The previous regex /^G[A-Z2-7]{55}$/ accepted any 56-char base32
  // string, including ones with a wrong Ed25519 checksum. Now we use
  // StrKey.isValidEd25519PublicKey which enforces the checksum.

  it('accepts a valid Stellar G-address for wallet_public_key', async () => {
    const realKey = Keypair.random().publicKey();
    const res = await request
      .post('/v1/agent/status')
      .set('X-Api-Key', testKey.key)
      .send({ wallet_public_key: realKey });
    assert.equal(res.status, 200);
    const row = /** @type {any} */ (
      db.prepare(`SELECT wallet_public_key FROM api_keys WHERE id = ?`).get(testKey.id)
    );
    assert.equal(row.wallet_public_key, realKey);
  });

  it('rejects a G-address with the right shape but wrong checksum (F2)', async () => {
    // 56-char base32 string starting with G — passes the old regex
    // but has a garbage checksum. StrKey.isValidEd25519PublicKey
    // catches this.
    const fakeKey = 'G' + 'A'.repeat(55);
    const res = await request
      .post('/v1/agent/status')
      .set('X-Api-Key', testKey.key)
      .send({ wallet_public_key: fakeKey });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_wallet_public_key');
  });

  it('rejects a non-string wallet_public_key', async () => {
    const res = await request
      .post('/v1/agent/status')
      .set('X-Api-Key', testKey.key)
      .send({ wallet_public_key: 12345 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_wallet_public_key');
  });

  // ── F1-agent-status: event fanout mirrors updated fields ─────────────────

  it('event payload only includes fields that were actually provided', async () => {
    // Spy on the event bus to see what gets emitted. Import a fresh
    // copy and wire a subscriber before the POST.
    delete require.cache[require.resolve('../../src/lib/event-bus')];
    const bus = require('../../src/lib/event-bus');
    /** @type {any[]} */
    const seen = [];
    const dispose = bus.subscribe((evt) => {
      if (evt.type === 'agent_state') seen.push(evt);
    });

    try {
      // Detail-only POST — the old code null-padded state and
      // wallet_public_key, confusing dashboard subscribers.
      const res = await request
        .post('/v1/agent/status')
        .set('X-Api-Key', testKey.key)
        .send({ detail: 'checking balance' });
      assert.equal(res.status, 200);
      // Give the event loop a tick to drain.
      await new Promise((r) => setImmediate(r));
    } finally {
      dispose();
    }

    // Must have seen exactly one event for this call. Allow earlier
    // events from other tests to leak through and skip them.
    const relevant = seen.filter((e) => e.api_key_id === testKey.id);
    assert.equal(relevant.length, 1, `expected 1 event, got ${relevant.length}`);
    const evt = relevant[0];
    // state and wallet_public_key must NOT be present (not provided
    // in the POST body), otherwise the dashboard SSE sees spurious
    // nulls and regresses UI state.
    assert.equal('state' in evt, false, 'state should be absent from event payload');
    assert.equal(
      'wallet_public_key' in evt,
      false,
      'wallet_public_key should be absent from event payload',
    );
    // detail must be present and match what was provided.
    assert.equal(evt.detail, 'checking balance');
  });
});
