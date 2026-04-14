// Unit tests for backend/src/lib/sanitize-error.js.
//
// This module is the gate between raw internal error messages (vcc
// traces, captcha solver output, playwright stack frames, scraper
// internals) and what agents see on /v1/orders/:id and failure
// webhook payloads. It was shipped with no test coverage — an easy
// place for a future refactor to silently widen the public surface.
//
// These tests lock the current contract in place:
//
//   1. Every recognised error maps to a FIXED, agent-safe PublicError.
//   2. Unrecognised errors fall through to the GENERIC bucket.
//   3. Error messages NEVER expose internal vocab (vcc, ctx, stage1/2,
//      playwright, chromium, yourrewardcard, scraper, captcha…).
//   4. Edge-case inputs (null, undefined, Error objects, objects,
//      numbers) all produce a valid PublicError without throwing.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sanitize, publicMessage, publicCode } = require('../../src/lib/sanitize-error');

// ── Shape / invariants ──────────────────────────────────────────────────────

describe('sanitize — output shape', () => {
  it('always returns an object with {code, message, retryable}', () => {
    const out = sanitize('anything');
    assert.equal(typeof out, 'object');
    assert.equal(typeof out.code, 'string');
    assert.equal(typeof out.message, 'string');
    assert.equal(typeof out.retryable, 'boolean');
  });

  it('code is always one of the stable set', () => {
    const STABLE_CODES = new Set([
      'fulfillment_unavailable',
      'insufficient_funds',
      'policy_blocked',
      'service_unavailable',
      'upstream_timeout',
      'payment_expired',
    ]);
    const cases = [
      '',
      'anything',
      'VCC job 123 failed: stage1 captcha timed out',
      'ETIMEDOUT',
      'insufficient balance on wallet GXYZ',
      'spend_limit_exceeded',
      'service_temporarily_unavailable',
      'payment window expired',
      'totally unknown string',
    ];
    for (const c of cases) {
      assert.ok(STABLE_CODES.has(sanitize(c).code), `code leaked for "${c}": ${sanitize(c).code}`);
    }
  });
});

// ── Recognised error routing ────────────────────────────────────────────────

describe('sanitize — recognised errors', () => {
  it('routes wallet balance errors to insufficient_funds', () => {
    const out = sanitize('insufficient balance on source account');
    assert.equal(out.code, 'insufficient_funds');
    assert.equal(out.retryable, true);
  });

  it('routes spend_limit_exceeded to policy_blocked', () => {
    const out = sanitize('spend_limit_exceeded: cap is $100');
    assert.equal(out.code, 'policy_blocked');
    assert.equal(out.retryable, false);
  });

  it('routes policy_blocked to policy_blocked', () => {
    const out = sanitize('policy_blocked: after-hours window');
    assert.equal(out.code, 'policy_blocked');
  });

  it('routes requires_approval to policy_blocked', () => {
    const out = sanitize('requires_approval: amount above threshold');
    assert.equal(out.code, 'policy_blocked');
  });

  it('routes service_temporarily_unavailable to service_unavailable', () => {
    const out = sanitize('service_temporarily_unavailable: circuit breaker tripped');
    assert.equal(out.code, 'service_unavailable');
    assert.equal(out.retryable, true);
  });

  it('routes "frozen" errors to service_unavailable', () => {
    const out = sanitize('backend frozen by ops');
    assert.equal(out.code, 'service_unavailable');
  });

  it('routes circuit-breaker-open errors to service_unavailable', () => {
    const out = sanitize('VCC circuit open — backing off after recent failures');
    // Matches both "VCC" (fulfillment_unavailable) and "circuit open"
    // (service_unavailable). "frozen/circuit" rule comes first → wins.
    assert.equal(out.code, 'service_unavailable');
  });

  it('routes network timeouts to upstream_timeout', () => {
    for (const e of [
      'ETIMEDOUT 169.254.169.254',
      'ECONNREFUSED',
      'ENETUNREACH',
      'EAI_AGAIN',
      'fetch failed',
      'HTTP 502 Bad Gateway',
      'HTTP 503 Service Unavailable',
      'HTTP 504 Gateway Timeout',
    ]) {
      assert.equal(sanitize(e).code, 'upstream_timeout', `expected upstream_timeout for ${e}`);
    }
  });

  it('routes payment-window expired to payment_expired', () => {
    const out = sanitize('order expired before payment');
    assert.equal(out.code, 'payment_expired');
    assert.equal(out.retryable, false);
  });
});

// ── Leak prevention — the core purpose of this module ─────────────────────

describe('sanitize — internal vocabulary is scrubbed', () => {
  const INTERNAL_VOCAB = [
    'vcc',
    'ctx',
    'stage1',
    'stage2',
    'yourrewardcard',
    'scraper',
    'captcha',
    'playwright',
    'chromium',
    'chrome',
    'libnspr',
    'recaptcha',
    'hcaptcha',
    'merchant',
    'gift-card',
  ];

  const INTERNAL_ERRORS = [
    'VCC job abc123 hit stage2 captcha timeout',
    'ctx_error: merchant 4567 declined',
    'gift-card scraper stage1 failed at yourrewardcard.com',
    'playwright: page.goto timeout at recaptcha challenge',
    'chromium browser crashed during stage2',
    'hCaptcha solver returned captcha_timeout',
    'CTX order 789 did not fulfil within 300s',
    'vcc-callback HMAC verification failed: bad_signature',
  ];

  for (const err of INTERNAL_ERRORS) {
    it(`scrubs internal error: ${err.slice(0, 50)}`, () => {
      const out = sanitize(err);
      // Public message must not mention any internal term — including
      // both the original vocab list and any word from the raw error.
      const lower = out.message.toLowerCase();
      for (const word of INTERNAL_VOCAB) {
        assert.ok(
          !lower.includes(word),
          `public message leaked "${word}" from raw: ${err}\nmessage: ${out.message}`,
        );
      }
      // Code must be one of the safe buckets, not the raw error text.
      assert.ok(!out.code.includes(' '));
      assert.ok(out.code.length < 40);
    });
  }

  it('unknown errors fall through to GENERIC (fulfillment_unavailable) with no leak', () => {
    const out = sanitize('some completely new internal error: /var/lib/secret-path.txt');
    assert.equal(out.code, 'fulfillment_unavailable');
    // Critical: the raw path must NOT appear in the public message.
    assert.ok(!out.message.includes('/var/lib'));
    assert.ok(!out.message.includes('secret-path'));
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('sanitize — edge case inputs', () => {
  it('null → GENERIC', () => {
    assert.equal(sanitize(null).code, 'fulfillment_unavailable');
  });

  it('undefined → GENERIC', () => {
    assert.equal(sanitize(undefined).code, 'fulfillment_unavailable');
  });

  it('empty string → GENERIC', () => {
    assert.equal(sanitize('').code, 'fulfillment_unavailable');
  });

  it('Error object uses .message', () => {
    const err = new Error('insufficient balance — wallet under reserve');
    assert.equal(sanitize(err).code, 'insufficient_funds');
  });

  it('Error object with internal vocab in .message is still scrubbed', () => {
    const err = new Error('VCC stage2 scraper timeout at yourrewardcard.com');
    const out = sanitize(err);
    assert.equal(out.code, 'fulfillment_unavailable');
    assert.ok(!out.message.toLowerCase().includes('vcc'));
    assert.ok(!out.message.toLowerCase().includes('yourrewardcard'));
  });

  it('number → GENERIC (String-coerced)', () => {
    assert.equal(sanitize(42).code, 'fulfillment_unavailable');
  });

  it('plain object → GENERIC (String-coerced to [object Object])', () => {
    assert.equal(sanitize({ foo: 'bar' }).code, 'fulfillment_unavailable');
  });

  it('very long string does not throw (O(n) regex, no catastrophic backtracking)', () => {
    const long = 'x'.repeat(100_000);
    const out = sanitize(long);
    assert.equal(out.code, 'fulfillment_unavailable');
  });
});

// ── publicMessage / publicCode wrappers ────────────────────────────────────

describe('publicMessage / publicCode', () => {
  it('publicMessage returns the message string', () => {
    const m = publicMessage('ETIMEDOUT');
    assert.equal(typeof m, 'string');
    assert.match(m, /timed out/i);
  });

  it('publicCode returns the code string', () => {
    assert.equal(publicCode('ETIMEDOUT'), 'upstream_timeout');
    assert.equal(publicCode('spend_limit_exceeded'), 'policy_blocked');
    assert.equal(publicCode(null), 'fulfillment_unavailable');
  });
});
