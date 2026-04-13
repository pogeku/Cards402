// Adversarial audit F1 — card data sealing roundtrip.
//
// In test/dev mode (no CARDS402_SECRET_BOX_KEY) seal is a pass-through and
// these assertions check the round-trip helper. We also flip the box key on
// for one test to prove the seal/open path produces opaque ciphertext at
// rest while still round-tripping cleanly.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

describe('card-vault — F1 sealing roundtrip', () => {
  it('passes plaintext through when no secret-box key is set (dev/test default)', () => {
    delete process.env.CARDS402_SECRET_BOX_KEY;
    delete process.env.VCC_TOKEN_KEY;
    // Re-require so the secret-box no-key fast path is hit fresh.
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    const { sealCard, openCard } = require('../../src/lib/card-vault');

    const sealed = sealCard({
      number: '4111111111111111',
      cvv: '123',
      expiry: '12/28',
      brand: 'Visa',
    });
    // Pass-through means the "sealed" form is still plaintext — no enc:
    // prefix because we have no key.
    assert.equal(sealed.number, '4111111111111111');
    assert.equal(sealed.cvv, '123');
    assert.equal(sealed.expiry, '12/28');
    // openCard accepts column-shape rows (card_number / card_cvv / ...).
    const open = openCard({
      card_number: sealed.number,
      card_cvv: sealed.cvv,
      card_expiry: sealed.expiry,
      card_brand: sealed.brand,
    });
    assert.equal(open.number, '4111111111111111');
  });

  it('seals to opaque ciphertext when a secret-box key is set, and openCard round-trips it back', () => {
    // Force-load the box key for this single test so we can observe the
    // sealed shape. Restored via finally so other tests aren't affected.
    const previousKey = process.env.CARDS402_SECRET_BOX_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = crypto.randomBytes(32).toString('hex');
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    try {
      const { sealCard, openCard } = require('../../src/lib/card-vault');
      const sealed = sealCard({
        number: '4111111111111111',
        cvv: '123',
        expiry: '12/28',
        brand: 'Visa',
      });
      // Sealed form must NOT contain the plaintext PAN or CVV.
      assert.ok(sealed.number.startsWith('enc:'));
      assert.ok(sealed.cvv.startsWith('enc:'));
      assert.ok(sealed.expiry.startsWith('enc:'));
      assert.ok(!sealed.number.includes('4111111111111111'));
      assert.ok(!sealed.cvv.includes('123'));
      // Brand stays plaintext.
      assert.equal(sealed.brand, 'Visa');

      // Round-trip back through openCard.
      const open = openCard({
        card_number: sealed.number,
        card_cvv: sealed.cvv,
        card_expiry: sealed.expiry,
        card_brand: sealed.brand,
      });
      assert.equal(open.number, '4111111111111111');
      assert.equal(open.cvv, '123');
      assert.equal(open.expiry, '12/28');
      assert.equal(open.brand, 'Visa');
    } finally {
      if (previousKey === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
      else process.env.CARDS402_SECRET_BOX_KEY = previousKey;
      delete require.cache[require.resolve('../../src/lib/secret-box')];
      delete require.cache[require.resolve('../../src/lib/card-vault')];
    }
  });
});
