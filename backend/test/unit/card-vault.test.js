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
      // Substring checks on hex-encoded output are probabilistically
      // flaky for short plaintexts (a 3-digit CVV can collide with a
      // 3-char hex window ~1 in 4000 seals). Check the actual
      // ciphertext bytes instead: decode the last colon-separated
      // part of the enc:… blob and assert the raw bytes aren't the
      // plaintext. Deterministic regardless of seed.
      const ctBytesNumber = Buffer.from(sealed.number.split(':').pop(), 'hex');
      const ctBytesCvv = Buffer.from(sealed.cvv.split(':').pop(), 'hex');
      assert.notEqual(ctBytesNumber.toString('utf8'), '4111111111111111');
      assert.notEqual(ctBytesCvv.toString('utf8'), '123');
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

  it('generates a fresh IV per seal so two seals of the same plaintext differ', () => {
    // GCM is only semantically secure with a unique IV per seal. If the
    // IV generation ever got fixed or re-seeded, identical plaintexts
    // would produce identical ciphertexts — trivially distinguishable
    // from randomness on a DB dump. Regression guard.
    const previousKey = process.env.CARDS402_SECRET_BOX_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = crypto.randomBytes(32).toString('hex');
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    try {
      const { sealCard } = require('../../src/lib/card-vault');
      const a = sealCard({
        number: '4111111111111111',
        cvv: '123',
        expiry: '12/28',
        brand: 'Visa',
      });
      const b = sealCard({
        number: '4111111111111111',
        cvv: '123',
        expiry: '12/28',
        brand: 'Visa',
      });
      assert.notEqual(
        a.number,
        b.number,
        'two seals of the same PAN must produce different ciphertexts',
      );
      assert.notEqual(a.cvv, b.cvv);
      assert.notEqual(a.expiry, b.expiry);
    } finally {
      if (previousKey === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
      else process.env.CARDS402_SECRET_BOX_KEY = previousKey;
      delete require.cache[require.resolve('../../src/lib/secret-box')];
      delete require.cache[require.resolve('../../src/lib/card-vault')];
    }
  });

  it('rejects a tampered ciphertext with a field-labelled error', () => {
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
      // Flip the last hex char of the ciphertext. GCM's tag check should
      // reject this and openCard should surface a card_number-labelled
      // error rather than the bare GCM "unable to authenticate data".
      const tamperedNumber =
        sealed.number.slice(0, -1) + (sealed.number.at(-1) === 'a' ? 'b' : 'a');
      assert.throws(
        () =>
          openCard({
            card_number: tamperedNumber,
            card_cvv: sealed.cvv,
            card_expiry: sealed.expiry,
            card_brand: 'Visa',
          }),
        /card-vault: failed to open card_number/,
      );
    } finally {
      if (previousKey === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
      else process.env.CARDS402_SECRET_BOX_KEY = previousKey;
      delete require.cache[require.resolve('../../src/lib/secret-box')];
      delete require.cache[require.resolve('../../src/lib/card-vault')];
    }
  });

  it('rejects a malformed sealed blob with a shape error, not a Buffer TypeError', () => {
    // Regression guard for the 2026-04-14 audit: a truncated row
    // (e.g. "enc:only-two-parts") used to call Buffer.from(undefined, 'hex')
    // and throw a generic `TypeError: The first argument must be of type
    // string`. secret-box.open now validates the 4-part shape first and
    // throws a specific "malformed sealed blob" error instead.
    const previousKey = process.env.CARDS402_SECRET_BOX_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = crypto.randomBytes(32).toString('hex');
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    try {
      const { openCard } = require('../../src/lib/card-vault');
      assert.throws(
        () =>
          openCard({
            card_number: 'enc:onlyoneparttruncated',
            card_cvv: null,
            card_expiry: null,
            card_brand: 'Visa',
          }),
        /card-vault: failed to open card_number.*malformed sealed blob/,
      );
    } finally {
      if (previousKey === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
      else process.env.CARDS402_SECRET_BOX_KEY = previousKey;
      delete require.cache[require.resolve('../../src/lib/secret-box')];
      delete require.cache[require.resolve('../../src/lib/card-vault')];
    }
  });

  it('rejects a sealed blob with non-hex characters in the iv/tag/ciphertext', () => {
    const previousKey = process.env.CARDS402_SECRET_BOX_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = crypto.randomBytes(32).toString('hex');
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    try {
      const { openCard } = require('../../src/lib/card-vault');
      assert.throws(
        () =>
          openCard({
            card_number: 'enc:not-hex-at-all:not-hex:not-hex',
            card_cvv: null,
            card_expiry: null,
            card_brand: null,
          }),
        /card-vault: failed to open card_number.*non-hex/,
      );
    } finally {
      if (previousKey === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
      else process.env.CARDS402_SECRET_BOX_KEY = previousKey;
      delete require.cache[require.resolve('../../src/lib/secret-box')];
      delete require.cache[require.resolve('../../src/lib/card-vault')];
    }
  });
});
