// Enabled-merchants helper tests. Ensures the static catalog shape is
// correct and the helpers return only enabled rows.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  listEnabledMerchants,
  getEnabledMerchant,
  isMerchantEnabled,
  ENABLED_MERCHANTS,
} = require('../../src/lib/enabled-merchants');

describe('enabled-merchants', () => {
  it('exposes at least the Visa eReward card', () => {
    const list = listEnabledMerchants();
    assert.ok(list.length >= 1);
    const visa = list.find((m) => /visa/i.test(m.name));
    assert.ok(visa, 'expected a Visa merchant in the enabled list');
    assert.equal(visa.currency, 'USD');
    assert.ok(visa.min_amount > 0);
    assert.ok(visa.max_amount >= visa.min_amount);
  });

  it('every enabled merchant has the required fields', () => {
    for (const m of listEnabledMerchants()) {
      for (const field of [
        'id',
        'name',
        'logo_url',
        'card_image_url',
        'country',
        'currency',
        'min_amount',
        'max_amount',
        'redeem_location',
        'redeem_type',
        'enabled',
        'description',
      ]) {
        assert.ok(
          m[field] !== undefined && m[field] !== null && m[field] !== '',
          `merchant ${m.id} missing ${field}`,
        );
      }
    }
  });

  it('getEnabledMerchant returns the row for a valid id', () => {
    const first = ENABLED_MERCHANTS[0];
    const got = getEnabledMerchant(first.id);
    assert.equal(got.id, first.id);
  });

  it('getEnabledMerchant returns null for unknown id', () => {
    assert.equal(getEnabledMerchant('not-a-real-merchant'), null);
  });

  it('isMerchantEnabled distinguishes enabled from unknown', () => {
    const first = ENABLED_MERCHANTS[0];
    assert.equal(isMerchantEnabled(first.id), true);
    assert.equal(isMerchantEnabled('bogus'), false);
  });

  it('does not leak merchants flagged as disabled', () => {
    // If we ever mark one as enabled: false in the static list, it must
    // not appear in listEnabledMerchants.
    const disabledCount = ENABLED_MERCHANTS.filter((m) => !m.enabled).length;
    assert.equal(listEnabledMerchants().length, ENABLED_MERCHANTS.length - disabledCount);
  });
});
