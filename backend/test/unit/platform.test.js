// Platform-owner identification tests. The helper is small but it's
// load-bearing for the alert visibility split — getting it wrong would
// either expose system alerts to every user (the bug we just fixed)
// or hide them from the actual operator.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { isPlatformOwner } = require('../../src/lib/platform');

describe('isPlatformOwner', () => {
  let original;

  beforeEach(() => {
    original = process.env.CARDS402_PLATFORM_OWNER_EMAIL;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    } else {
      process.env.CARDS402_PLATFORM_OWNER_EMAIL = original;
    }
  });

  it('returns false when the env var is not set', () => {
    delete process.env.CARDS402_PLATFORM_OWNER_EMAIL;
    assert.equal(isPlatformOwner('anything@example.com'), false);
  });

  it('returns false for a non-matching email', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner('user@example.com'), false);
  });

  it('returns true for an exact email match', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner('ops@cards402.test'), true);
  });

  it('is case-insensitive', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'Ops@Cards402.Test';
    assert.equal(isPlatformOwner('OPS@cards402.test'), true);
  });

  it('trims surrounding whitespace on both sides', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = '  ops@cards402.test  ';
    assert.equal(isPlatformOwner(' ops@cards402.test '), true);
  });

  it('returns false on null / undefined / empty input', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner(null), false);
    assert.equal(isPlatformOwner(undefined), false);
    assert.equal(isPlatformOwner(''), false);
  });

  // ── F1-platform: fail closed on non-string truthy input ────────────────
  //
  // Pre-fix, `!email` only caught null / undefined / empty string. A
  // truthy non-string (number, boolean, object, array) reached
  // `email.trim()` and crashed with TypeError. The helper is exported
  // with a permissive signature and could be called from anywhere, so
  // a defensive typeof check at a security boundary is cheap insurance.

  it('F1: returns false on a number input (does not crash)', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner(/** @type {any} */ (42)), false);
  });

  it('F1: returns false on a boolean input', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner(/** @type {any} */ (true)), false);
    assert.equal(isPlatformOwner(/** @type {any} */ (false)), false);
  });

  it('F1: returns false on an object input', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner(/** @type {any} */ ({ email: 'ops@cards402.test' })), false);
  });

  it('F1: returns false on an array input', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner(/** @type {any} */ (['ops@cards402.test'])), false);
  });

  it('F1: returns false when CARDS402_PLATFORM_OWNER_EMAIL is set to a non-string', () => {
    // Unreachable via env.js (all env values are strings) but the helper
    // reads process.env directly at every call and a test harness
    // monkey-patching process.env could set a non-string value.
    /** @type {any} */ (process.env).CARDS402_PLATFORM_OWNER_EMAIL = 42;
    assert.equal(isPlatformOwner('ops@cards402.test'), false);
  });

  // ── F2-platform: fail closed when either side trims to empty ───────────
  //
  // The pre-fix comparison `trim().toLowerCase() === trim().toLowerCase()`
  // was TRUE when both sides trimmed to the empty string — a silent
  // privilege escalation where "whitespace-only email" matched
  // "whitespace-only configured" as a valid identity.

  it('F2: returns false when configured env is whitespace-only', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = '   ';
    assert.equal(isPlatformOwner('   '), false);
    assert.equal(isPlatformOwner('ops@cards402.test'), false);
    assert.equal(isPlatformOwner(''), false);
  });

  it('F2: returns false when email input is whitespace-only', () => {
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = 'ops@cards402.test';
    assert.equal(isPlatformOwner('   '), false);
    assert.equal(isPlatformOwner('\t\r\n'), false);
  });

  it('F2: whitespace-only env AND whitespace-only email do NOT match', () => {
    // The scary case: pre-fix this returned TRUE.
    process.env.CARDS402_PLATFORM_OWNER_EMAIL = '   ';
    assert.equal(isPlatformOwner('\t'), false);
    assert.equal(isPlatformOwner(' '), false);
  });
});
