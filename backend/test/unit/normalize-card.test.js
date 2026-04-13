// Card brand normalisation — strips the upstream CTX merchant string
// before it can leak into agent transcripts. See lib/normalize-card.js
// for the rationale.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCardBrand } = require('../../src/lib/normalize-card');

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
