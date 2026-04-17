// Integration tests for the MPP router (Phase 1 scope):
//   GET /v1/.well-known/mpp    — discovery doc
//   GET /v1/cards/visa/:amount — 402 challenge
//   GET /v1/mpp/receipts/:id   — receipt stub
//
// No payment verification is exercised here — Phase 2 adds that.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { request, db } = require('../helpers/app');

beforeEach(() => {
  db.prepare(`DELETE FROM mpp_challenges`).run();
});

describe('GET /v1/.well-known/mpp', () => {
  it('returns a discovery document with the expected shape', async () => {
    const res = await request.get('/v1/.well-known/mpp');
    assert.equal(res.status, 200);
    assert.equal(res.body.protocol, 'mpp/1.0');
    assert.deepEqual(res.body.accepts, ['stellar']);
    assert.ok(Array.isArray(res.body.resources));
    assert.equal(res.body.resources[0].pattern, '/v1/cards/visa/{amount_usdc}');
    assert.ok(res.body.stellar.receiver_contract);
    assert.match(res.body.stellar.usdc_asset, /^USDC:/);
  });

  it('serves without requiring an API key', async () => {
    const res = await request.get('/v1/.well-known/mpp'); // no X-Api-Key
    assert.equal(res.status, 200);
  });
});

describe('GET /v1/cards/visa/:amount — 402 challenge', () => {
  it('returns 402 with a well-formed challenge', async () => {
    const res = await request.get('/v1/cards/visa/10.00');
    assert.equal(res.status, 402);
    assert.match(res.headers['www-authenticate'], /^Payment realm="cards402"/);
    assert.match(res.headers['www-authenticate'], /challenge="mpp_c_/);
    assert.equal(res.body.error, 'payment_required');
    assert.equal(res.body.protocol, 'mpp/1.0');
    assert.equal(res.body.amount.value, '10.00');
    assert.equal(res.body.amount.currency, 'USD');
    assert.ok(res.body.challenge_id.startsWith('mpp_c_'));
    assert.ok(res.body.expires_at);
    assert.ok(Array.isArray(res.body.methods));
    const usdcMethod = res.body.methods.find((m) => m.function === 'pay_usdc');
    assert.ok(usdcMethod);
    assert.equal(usdcMethod.scheme, 'stellar');
    assert.equal(usdcMethod.kind, 'soroban_contract');
    assert.equal(usdcMethod.memo_field, 'order_id');
    assert.equal(usdcMethod.memo_value, res.body.challenge_id);
    assert.equal(usdcMethod.amount, '10.00');
    assert.equal(usdcMethod.amount_stroops, '100000000');
    assert.equal(res.body.retry_url, '/v1/cards/visa/10.00');
  });

  it('persists the challenge to mpp_challenges table', async () => {
    const res = await request.get('/v1/cards/visa/5.00');
    assert.equal(res.status, 402);
    const row = db.prepare(`SELECT * FROM mpp_challenges WHERE id = ?`).get(res.body.challenge_id);
    assert.ok(row);
    assert.equal(row.amount_usdc, '5.00');
  });

  it('rejects malformed amounts with 400', async () => {
    const r1 = await request.get('/v1/cards/visa/abc');
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'invalid_amount');

    const r2 = await request.get('/v1/cards/visa/10.123');
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'invalid_amount');
  });

  it('rejects amounts outside the bounds', async () => {
    const tooSmall = await request.get('/v1/cards/visa/0.00');
    assert.equal(tooSmall.status, 400);
    assert.equal(tooSmall.body.error, 'amount_out_of_bounds');

    const tooLarge = await request.get('/v1/cards/visa/99999.99');
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.body.error, 'amount_out_of_bounds');
  });

  it('accepts whole-number amounts and normalises to two decimals', async () => {
    const res = await request.get('/v1/cards/visa/5');
    assert.equal(res.status, 402);
    assert.equal(res.body.amount.value, '5.00');
    assert.equal(res.body.retry_url, '/v1/cards/visa/5');
  });

  it('rejects malformed credentials at parse time (400)', async () => {
    const res = await request
      .get('/v1/cards/visa/10.00')
      .set('Authorization', 'Payment scheme="stellar", challenge="x", tx_hash="y"');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'malformed_credential');
  });

  it('each call creates a new challenge (no caching)', async () => {
    const a = await request.get('/v1/cards/visa/7.00');
    const b = await request.get('/v1/cards/visa/7.00');
    assert.notEqual(a.body.challenge_id, b.body.challenge_id);
  });

  it('serves without requiring an API key', async () => {
    const res = await request.get('/v1/cards/visa/1.00');
    assert.equal(res.status, 402);
  });

  it('sets Cache-Control: no-store on the 402', async () => {
    const res = await request.get('/v1/cards/visa/1.00');
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

describe('GET /v1/mpp/receipts/:id — Phase 1 stub', () => {
  it('returns 404 for unknown receipt ids', async () => {
    const res = await request.get('/v1/mpp/receipts/mpp_r_doesnotexist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'receipt_not_found');
  });
});

describe('MPP carve-out: other /v1 routes still require auth', () => {
  it('POST /v1/orders without a key still 401s', async () => {
    const res = await request.post('/v1/orders').send({ amount_usdc: '1.00' });
    assert.equal(res.status, 401);
  });
});
