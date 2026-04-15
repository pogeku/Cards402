// Card brand normalisation — strips the upstream CTX merchant string
// before it can leak into agent transcripts. See lib/normalize-card.js
// for the rationale.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCardBrand, _resetWarnedBrands } = require('../../src/lib/normalize-card');

describe('normalizeCardBrand', () => {
  it('replaces the verbose Visa eReward string with USD Visa Card', () => {
    assert.equal(
      normalizeCardBrand('Visa® Reward Card, 6-Month Expiration [ITNL] eGift Card'),
      'USD Visa Card',
    );
  });

  it('replaces a bare Visa string with USD Visa Card', () => {
    assert.equal(normalizeCardBrand('Visa'), 'USD Visa Card');
  });

  it('replaces Mastercard variants with USD Mastercard', () => {
    assert.equal(normalizeCardBrand('Mastercard® Prepaid'), 'USD Mastercard');
    assert.equal(normalizeCardBrand('Master Card eGift'), 'USD Mastercard');
  });

  it('replaces Amex variants with USD Amex Card', () => {
    assert.equal(normalizeCardBrand('Amex Gift'), 'USD Amex Card');
    assert.equal(normalizeCardBrand('American Express eReward'), 'USD Amex Card');
  });

  it('replaces Discover with USD Discover Card', () => {
    assert.equal(normalizeCardBrand('Discover ® eGift'), 'USD Discover Card');
  });

  it('falls back to USD Prepaid Card for unknown schemes', () => {
    assert.equal(normalizeCardBrand('Some Niche Local Issuer'), 'USD Prepaid Card');
  });

  it('returns null for null/empty input', () => {
    assert.equal(normalizeCardBrand(null), null);
    assert.equal(normalizeCardBrand(undefined), null);
    assert.equal(normalizeCardBrand(''), null);
  });

  it('case-insensitive matching', () => {
    assert.equal(normalizeCardBrand('VISA'), 'USD Visa Card');
    assert.equal(normalizeCardBrand('mastercard'), 'USD Mastercard');
  });
});

// ── F1-normalize-card: whitespace-only input → null, not fallback ──────────
//
// Pre-fix, `'   '.toLowerCase()` stayed a truthy string, no substring
// matched, and the function returned 'USD Prepaid Card' — hiding upstream
// data corruption behind a plausible-looking label. Post-fix, the input
// is trimmed first; whitespace-only collapses to empty → null.

describe('F1-normalize-card: whitespace-only input', () => {
  beforeEach(() => _resetWarnedBrands());

  it('returns null for a whitespace-only string (not "USD Prepaid Card")', () => {
    assert.equal(normalizeCardBrand('   '), null);
  });

  it('returns null for a tab-only string', () => {
    assert.equal(normalizeCardBrand('\t\t'), null);
  });

  it('returns null for a CRLF-only string', () => {
    assert.equal(normalizeCardBrand('\r\n'), null);
  });

  it('still matches when the real brand has surrounding whitespace', () => {
    // Trimming must not break legit inputs with stray whitespace.
    assert.equal(normalizeCardBrand('  Visa® Reward Card  '), 'USD Visa Card');
    assert.equal(normalizeCardBrand('\nMastercard® Prepaid\n'), 'USD Mastercard');
  });
});

// ── F2-normalize-card: unknown scheme logs exactly once ────────────────────
//
// Pre-fix the fallback path was completely silent — when CTX introduced
// a new product SKU the agent silently saw 'USD Prepaid Card' and ops
// had no signal. Post-fix: dedup'd warn + bizEvent on first sight of
// each unique raw value.

describe('F2-normalize-card: unknown-brand logging', () => {
  let origWarn;
  let warns;

  beforeEach(() => {
    _resetWarnedBrands();
    warns = [];
    origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  it('logs a warn on first sight of an unknown brand', () => {
    const out = normalizeCardBrand('Some Niche Local Issuer');
    assert.equal(out, 'USD Prepaid Card');
    assert.ok(
      warns.some((w) => /unknown brand.*"Some Niche Local Issuer"/.test(w)),
      `expected unknown-brand warn, got: ${JSON.stringify(warns)}`,
    );
  });

  it('warns exactly ONCE per unique raw value (dedup across calls)', () => {
    for (let i = 0; i < 5; i++) {
      normalizeCardBrand('Some Niche Local Issuer');
    }
    const matching = warns.filter((w) => /"Some Niche Local Issuer"/.test(w));
    assert.equal(matching.length, 1, `expected 1 dedup'd warn, got ${matching.length}`);
  });

  it('warns independently for distinct unknown brands', () => {
    normalizeCardBrand('Some Niche Local Issuer');
    normalizeCardBrand('Another Unknown Scheme');
    normalizeCardBrand('Some Niche Local Issuer'); // dedup
    assert.equal(warns.filter((w) => /"Some Niche Local Issuer"/.test(w)).length, 1);
    assert.equal(warns.filter((w) => /"Another Unknown Scheme"/.test(w)).length, 1);
  });

  it('does NOT warn for recognised brands (Visa/MC/Amex/Discover)', () => {
    normalizeCardBrand('Visa® Reward Card');
    normalizeCardBrand('Mastercard® Prepaid');
    normalizeCardBrand('American Express Gift Card');
    normalizeCardBrand('Discover ® eGift');
    assert.equal(warns.length, 0, `unexpected warns: ${JSON.stringify(warns)}`);
  });

  it('does NOT warn for null / undefined / empty / whitespace (F1 guard runs first)', () => {
    normalizeCardBrand(null);
    normalizeCardBrand(undefined);
    normalizeCardBrand('');
    normalizeCardBrand('   ');
    // Null/empty/whitespace return null WITHOUT hitting the fallback branch,
    // so no warn fires — callers see the corruption directly.
    assert.equal(warns.length, 0);
  });

  it('dedup is on the trimmed value so whitespace variants collapse', () => {
    normalizeCardBrand('Niche Issuer');
    normalizeCardBrand('  Niche Issuer  '); // trimmed — same offender
    normalizeCardBrand('Niche Issuer\n'); // trimmed — same offender
    assert.equal(warns.filter((w) => /"Niche Issuer"/.test(w)).length, 1);
  });
});
