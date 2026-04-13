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
});
