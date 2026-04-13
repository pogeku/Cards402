// Unit tests for the shared HMAC sign/verify helper in src/lib/hmac.js.
// Mirrors the contract expected by vcc/api/src/lib/hmac.js (same file).

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { signCallback, verifyCallback, safeEqHex } = require('../../src/lib/hmac');

const SECRET = 'very-long-test-secret-at-least-32-chars-please';
const ORDER_ID = '11111111-2222-3333-4444-555555555555';
const BODY = JSON.stringify({ order_id: ORDER_ID, status: 'fulfilled', foo: 'bar' });

describe('signCallback', () => {
  it('produces a deterministic hex digest', () => {
    const ts = '1700000000000';
    const a = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const b = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('changes when any input changes', () => {
    const base = signCallback({ secret: SECRET, timestamp: '1', orderId: 'a', rawBody: 'x' });
    assert.notEqual(
      base,
      signCallback({ secret: SECRET + 'x', timestamp: '1', orderId: 'a', rawBody: 'x' }),
    );
    assert.notEqual(
      base,
      signCallback({ secret: SECRET, timestamp: '2', orderId: 'a', rawBody: 'x' }),
    );
    assert.notEqual(
      base,
      signCallback({ secret: SECRET, timestamp: '1', orderId: 'b', rawBody: 'x' }),
    );
    assert.notEqual(
      base,
      signCallback({ secret: SECRET, timestamp: '1', orderId: 'a', rawBody: 'y' }),
    );
  });

  it('throws on missing inputs', () => {
    assert.throws(() => signCallback({ timestamp: '1', orderId: 'a', rawBody: 'x' }), /secret/);
    assert.throws(() => signCallback({ secret: SECRET, orderId: 'a', rawBody: 'x' }), /timestamp/);
    assert.throws(() => signCallback({ secret: SECRET, timestamp: '1', rawBody: 'x' }), /orderId/);
    assert.throws(() => signCallback({ secret: SECRET, timestamp: '1', orderId: 'a' }), /rawBody/);
  });

  it('accepts empty rawBody string', () => {
    // Empty body is a valid edge case (e.g. failure callback with no card).
    const sig = signCallback({ secret: SECRET, timestamp: '1', orderId: 'a', rawBody: '' });
    assert.match(sig, /^[0-9a-f]{64}$/);
  });
});

describe('signCallback — v3 with nonce', () => {
  it('produces a different digest when nonce is added', () => {
    const ts = '1700000000000';
    const withoutNonce = signCallback({
      secret: SECRET,
      timestamp: ts,
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    const withNonce = signCallback({
      secret: SECRET,
      timestamp: ts,
      orderId: ORDER_ID,
      rawBody: BODY,
      nonce: 'my-nonce',
    });
    assert.notEqual(withoutNonce, withNonce);
  });

  it('changes when nonce changes', () => {
    const ts = '1';
    const a = signCallback({
      secret: SECRET,
      timestamp: ts,
      orderId: 'a',
      rawBody: 'x',
      nonce: 'n1',
    });
    const b = signCallback({
      secret: SECRET,
      timestamp: ts,
      orderId: 'a',
      rawBody: 'x',
      nonce: 'n2',
    });
    assert.notEqual(a, b);
  });
});

describe('verifyCallback — v3 with nonce', () => {
  const NONCE = 'test-nonce-uuid-1234';

  it('accepts a valid v3 envelope', () => {
    const ts = String(Date.now());
    const sig = signCallback({
      secret: SECRET,
      timestamp: ts,
      orderId: ORDER_ID,
      rawBody: BODY,
      nonce: NONCE,
    });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      nonce: NONCE,
      rawBody: BODY,
    });
    assert.deepEqual(v, { ok: true, version: 3 });
  });

  it('rejects when nonce is swapped', () => {
    const ts = String(Date.now());
    const sig = signCallback({
      secret: SECRET,
      timestamp: ts,
      orderId: ORDER_ID,
      rawBody: BODY,
      nonce: NONCE,
    });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      nonce: 'wrong-nonce',
      rawBody: BODY,
    });
    // v3 fails, falls through to v2, which also fails (nonce was in payload)
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('falls back to v2 when nonce is absent from verify but was not in sign', () => {
    const ts = String(Date.now());
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      nonce: undefined,
      rawBody: BODY,
    });
    assert.deepEqual(v, { ok: true, version: 2 });
  });

  it('falls back to v2 when v3 verifier has a nonce but the sender did not sign with one', () => {
    // Transition case: sender is still on v2, receiver supplies a nonce.
    const ts = String(Date.now());
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      nonce: 'some-nonce', // receiver has it but sender didn't sign with it
      rawBody: BODY,
    });
    // v3 check fails (wrong payload shape), but v2 check succeeds
    assert.equal(v.ok, true);
    assert.equal(v.version, 2);
  });
});

describe('verifyCallback — v2', () => {
  it('accepts a valid v2 envelope', () => {
    const ts = String(Date.now());
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    assert.deepEqual(v, { ok: true, version: 2 });
  });

  it('accepts the hex signature without sha256= prefix', () => {
    const ts = String(Date.now());
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: sig, // no prefix
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    assert.equal(v.ok, true);
  });

  it('rejects when order_id is swapped', () => {
    const ts = String(Date.now());
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: 'some-other-uuid',
      rawBody: BODY,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('rejects when body is tampered', () => {
    const ts = String(Date.now());
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY.replace('bar', 'baz'),
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });
});

describe('verifyCallback — v1 rejection (audit F6)', () => {
  // F6 removed v1 acceptance. v1 was `${timestamp}.${rawBody}` with no
  // order_id binding — a leaked secret could be used to forge a callback
  // for any order. Both services have shipped v3 since the C-3 nonce work,
  // so the legacy fallback was a forgery surface with no remaining users.
  function v1Sign(ts, body) {
    return crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  }

  it('rejects a v1 signature even when no X-VCC-Order-Id is supplied', () => {
    const ts = String(Date.now());
    const sig = v1Sign(ts, BODY);
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: undefined,
      rawBody: BODY,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('rejects a v1 signature when an X-VCC-Order-Id header is present', () => {
    const ts = String(Date.now());
    const sig = v1Sign(ts, BODY);
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });
});

describe('verifyCallback — edge cases', () => {
  it('rejects empty secret', () => {
    const v = verifyCallback({
      secret: '',
      timestamp: '1',
      signatureHeader: 'sha256=deadbeef',
      rawBody: 'x',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_fields');
  });

  it('rejects missing signature header', () => {
    const v = verifyCallback({
      secret: SECRET,
      timestamp: '1',
      signatureHeader: null,
      rawBody: 'x',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_fields');
  });

  it('rejects missing timestamp', () => {
    const v = verifyCallback({
      secret: SECRET,
      timestamp: null,
      signatureHeader: 'sha256=deadbeef',
      rawBody: 'x',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_fields');
  });

  it('rejects non-numeric timestamp', () => {
    const v = verifyCallback({
      secret: SECRET,
      timestamp: 'not-a-number',
      signatureHeader: 'sha256=deadbeef',
      rawBody: 'x',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing_fields');
  });

  it('rejects signatures with non-hex characters', () => {
    const v = verifyCallback({
      secret: SECRET,
      timestamp: String(Date.now()),
      signatureHeader: 'sha256=ZZZZZZ',
      rawBody: 'x',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'bad_signature');
  });

  it('rejects stale timestamps beyond the skew window', () => {
    const ts = String(Date.now() - 20 * 60 * 1000); // 20 min ago
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'timestamp_expired');
  });

  it('rejects future timestamps beyond the skew window', () => {
    const ts = String(Date.now() + 20 * 60 * 1000); // 20 min ahead
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'timestamp_expired');
  });

  it('honors maxSkewMs override', () => {
    const ts = String(Date.now() - 60 * 1000); // 1 min ago
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    // With 10s window, 1-min-old should fail
    const strict = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
      maxSkewMs: 10 * 1000,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.reason, 'timestamp_expired');
    // With default 10-min window, should pass
    const lax = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
    });
    assert.equal(lax.ok, true);
  });

  it('honors injected `now` for deterministic testing', () => {
    const now = 2_000_000_000_000;
    const ts = String(now - 30 * 1000); // 30s before injected now
    const sig = signCallback({ secret: SECRET, timestamp: ts, orderId: ORDER_ID, rawBody: BODY });
    const v = verifyCallback({
      secret: SECRET,
      timestamp: ts,
      signatureHeader: `sha256=${sig}`,
      orderId: ORDER_ID,
      rawBody: BODY,
      now,
    });
    assert.equal(v.ok, true);
  });
});

describe('safeEqHex', () => {
  it('returns true for equal hex strings', () => {
    assert.equal(safeEqHex('deadbeef', 'deadbeef'), true);
  });

  it('returns false for different hex strings of equal length', () => {
    assert.equal(safeEqHex('deadbeef', 'deadbeee'), false);
  });

  it('returns false for different lengths (no throw)', () => {
    assert.equal(safeEqHex('dead', 'deadbeef'), false);
  });

  it('returns false on malformed hex without throwing', () => {
    // Non-hex characters are rejected before reaching Buffer.from.
    assert.equal(safeEqHex('zz', 'zz'), false);
    assert.equal(safeEqHex('zz', 'yy'), false);
    assert.equal(safeEqHex('abc', 'abcd'), false); // length mismatch
    assert.equal(safeEqHex(null, 'dead'), false);
    assert.equal(safeEqHex('dead', undefined), false);
  });
});
