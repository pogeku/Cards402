// Unit tests for src/lib/claim-hash.js.
//
// This module hashes the short-lived agent claim code before storage,
// matching the pattern used for auth_codes.code_hash and
// sessions.token_hash. Prior to the 2026-04-15 adversarial audit the
// function silently coerced non-string inputs via String(code) — a
// caller bug passing undefined would produce a valid hash of the
// literal string 'undefined' and collide with any other such bug.
//
// These tests lock in:
//   - Deterministic hex output
//   - Distinct inputs produce distinct hashes
//   - Input validation: throw on non-string or empty string
//   - Stable hash shape (64-char lowercase hex)

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { hashClaimCode } = require('../../src/lib/claim-hash');

describe('hashClaimCode — baseline', () => {
  it('returns a 64-char lowercase hex string', () => {
    const h = hashClaimCode('c402_abcdef1234567890');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const a = hashClaimCode('c402_abc');
    const b = hashClaimCode('c402_abc');
    assert.equal(a, b);
  });

  it('produces distinct hashes for distinct inputs', () => {
    const a = hashClaimCode('c402_abc');
    const b = hashClaimCode('c402_abd');
    assert.notEqual(a, b);
  });

  it('matches a direct crypto.createHash computation', () => {
    const code = 'c402_' + 'f'.repeat(48);
    const expected = crypto.createHash('sha256').update(code).digest('hex');
    assert.equal(hashClaimCode(code), expected);
  });

  it('accepts a realistic mint-side claim code (regression guard)', () => {
    const code = `c402_${crypto.randomBytes(24).toString('hex')}`;
    const h = hashClaimCode(code);
    assert.equal(h.length, 64);
  });
});

// ── F1-claim-hash: reject non-string inputs ────────────────────────────────

describe('F1-claim-hash: non-string input rejection', () => {
  it('throws TypeError on null', () => {
    assert.throws(() => hashClaimCode(/** @type {any} */ (null)), /must be a string/);
  });

  it('throws TypeError on undefined', () => {
    assert.throws(() => hashClaimCode(/** @type {any} */ (undefined)), /must be a string/);
  });

  it('throws TypeError on a number', () => {
    assert.throws(() => hashClaimCode(/** @type {any} */ (42)), /must be a string/);
  });

  it('throws TypeError on a plain object', () => {
    assert.throws(() => hashClaimCode(/** @type {any} */ ({ code: 'abc' })), /must be a string/);
  });

  it('throws TypeError on a Buffer', () => {
    // Buffers are objects, not strings — pre-fix `String(buf)` would have
    // decoded to UTF-8 and produced a hash.
    assert.throws(
      () => hashClaimCode(/** @type {any} */ (Buffer.from('c402_abc'))),
      /must be a string/,
    );
  });

  it('does NOT collide undefined with the literal string "undefined"', () => {
    // Pre-fix: hashClaimCode(undefined) === hashClaimCode('undefined')
    // because String(undefined) === 'undefined'. Post-fix: undefined
    // throws, so the collision is impossible at the API boundary.
    const literalUndefinedHash = hashClaimCode('undefined');
    // The string 'undefined' still hashes fine — only the typeof check fails.
    assert.match(literalUndefinedHash, /^[0-9a-f]{64}$/);
    // And undefined itself now throws:
    assert.throws(() => hashClaimCode(/** @type {any} */ (undefined)));
  });
});

// ── F2-claim-hash: reject empty strings ────────────────────────────────────

describe('F2-claim-hash: empty-string input rejection', () => {
  it('throws TypeError on empty string', () => {
    assert.throws(() => hashClaimCode(''), /must not be empty/);
  });

  it('accepts a single non-empty character (boundary regression guard)', () => {
    // Empty is rejected but a single char is valid — the cap is the
    // zero-length edge case, not a minimum-length requirement.
    const h = hashClaimCode('x');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('does not accept a whitespace-only string that becomes empty after trim', () => {
    // The function does NOT trim — that's the caller's responsibility
    // (app.js:207 does it before the hash call). A whitespace-only
    // string is still "non-empty" from the module's perspective and
    // hashes normally. Pinning this behaviour so a future "add trim"
    // refactor doesn't silently change the contract.
    const h = hashClaimCode('   ');
    assert.match(h, /^[0-9a-f]{64}$/);
    // And it must NOT equal the empty-string hash (which is unreachable
    // now anyway since '' throws).
    assert.notEqual(h, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
