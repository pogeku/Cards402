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

  // ── F1-card-vault regression guards ──────────────────────────────────────
  //
  // sealCard previously used `card.number ? seal : null`, which silently
  // stored null for any falsy value including empty strings, whitespace-
  // stripped-to-empty, and non-string types from an upstream parser bug.
  // A VCC response regression yielding `{number: ""}` would then pass
  // through and the order would flip to `delivered` with no usable PAN.
  // Below: null/undefined are still tolerated (partial cards), but "" and
  // non-string types must throw.

  it('rejects an empty-string number with a field-labelled error', () => {
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    const { sealCard } = require('../../src/lib/card-vault');
    assert.throws(
      () => sealCard({ number: '', cvv: '123', expiry: '12/28', brand: 'Visa' }),
      /card-vault: cannot seal number: empty string/,
    );
  });

  it('rejects an empty-string cvv with a field-labelled error', () => {
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    const { sealCard } = require('../../src/lib/card-vault');
    assert.throws(
      () => sealCard({ number: '4111111111111111', cvv: '', expiry: '12/28', brand: 'Visa' }),
      /card-vault: cannot seal cvv: empty string/,
    );
  });

  it('rejects a non-string number (upstream parser type regression)', () => {
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    const { sealCard } = require('../../src/lib/card-vault');
    assert.throws(
      () =>
        sealCard({
          // @ts-expect-error — intentional wrong type
          number: 4111111111111111,
          cvv: '123',
          expiry: '12/28',
          brand: 'Visa',
        }),
      /card-vault: cannot seal number: expected string, got number/,
    );
  });

  it('still tolerates null / undefined for a partial card payload', () => {
    delete process.env.CARDS402_SECRET_BOX_KEY;
    delete process.env.VCC_TOKEN_KEY;
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    const { sealCard } = require('../../src/lib/card-vault');
    const sealed = sealCard({ number: null, cvv: undefined, expiry: null, brand: 'Visa' });
    assert.equal(sealed.number, null);
    assert.equal(sealed.cvv, null);
    assert.equal(sealed.expiry, null);
    assert.equal(sealed.brand, 'Visa');
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

// ── F1/F2/F3 card-vault hardening (2026-04-15) ─────────────────────────
//
// Defensive guards on sealCard / sealField:
//
//   F1: sealCard(null) previously crashed with
//       TypeError: Cannot read properties of null. Every caller
//       currently gates with `if (card)` upstream but a future
//       refactor that drops the guard would turn into a 500 on every
//       delivery. Explicit null/undefined/non-object rejection with
//       a greppable card-vault error instead.
//
//   F2: sealField now caps fields at 64 bytes (MAX_FIELD_BYTES).
//       Real PANs are 13-19 digits (19 bytes max), CVVs 3-4,
//       expiries 5-7 chars. 64 bytes is ~3x the largest legitimate
//       value. Bounds the DB-bloat / memory-pressure blast radius
//       of a buggy upstream sending a huge string.
//
//   F3: sealField now rejects whitespace-only strings (' ', '\t\t',
//       etc.) with the same fail-loud story as the existing empty-
//       string rejection. A VCC parser glitch producing whitespace-
//       only fields would previously seal and deliver garbage — the
//       order flips to `delivered` with no refund path.

describe('card-vault — F1 sealCard input guard', () => {
  // Reset caches so each test gets fresh modules with the current env.
  const reload = () => {
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    return require('../../src/lib/card-vault');
  };

  it('rejects null input with a greppable card-vault error', () => {
    const { sealCard } = reload();
    assert.throws(() => sealCard(null), /card-vault: sealCard called with null/);
  });

  it('rejects undefined input', () => {
    const { sealCard } = reload();
    assert.throws(() => sealCard(undefined), /card-vault: sealCard called with null/);
  });

  it('rejects a non-object input (string)', () => {
    const { sealCard } = reload();
    assert.throws(
      () => sealCard(/** @type {any} */ ('not-an-object')),
      /card-vault: sealCard expected a plain object, got string/,
    );
  });

  it('rejects an array input', () => {
    const { sealCard } = reload();
    assert.throws(
      () =>
        sealCard(
          /** @type {any} */ ([{ number: '4111', cvv: '123', expiry: '12/27', brand: 'Visa' }]),
        ),
      /card-vault: sealCard expected a plain object, got array/,
    );
  });
});

describe('card-vault — F2 field length cap', () => {
  const reload = () => {
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    return require('../../src/lib/card-vault');
  };

  it('rejects a card_number over 64 bytes', () => {
    const { sealCard } = reload();
    assert.throws(
      () =>
        sealCard({
          number: '4'.repeat(100),
          cvv: '123',
          expiry: '12/27',
          brand: 'Visa',
        }),
      /card-vault: cannot seal number: value is 100 bytes, max 64/,
    );
  });

  it('rejects a huge cvv', () => {
    const { sealCard } = reload();
    assert.throws(
      () =>
        sealCard({
          number: '4111111111111111',
          cvv: 'X'.repeat(1000),
          expiry: '12/27',
          brand: 'Visa',
        }),
      /card-vault: cannot seal cvv.*max 64/,
    );
  });

  it('accepts real-world card values', () => {
    const { sealCard } = reload();
    // 19-digit PAN is the longest real ISO/IEC 7812 format.
    const sealed = sealCard({
      number: '4111111111111111234',
      cvv: '1234',
      expiry: '12/2027',
      brand: 'Visa',
    });
    assert.equal(sealed.number, '4111111111111111234');
    assert.equal(sealed.cvv, '1234');
  });

  it('rejects exactly 65 bytes (off-by-one boundary)', () => {
    const { sealCard } = reload();
    assert.throws(
      () =>
        sealCard({
          number: 'x'.repeat(65),
          cvv: '123',
          expiry: '12/27',
          brand: 'Visa',
        }),
      /value is 65 bytes, max 64/,
    );
  });

  it('accepts exactly 64 bytes (off-by-one boundary)', () => {
    const { sealCard } = reload();
    const sealed = sealCard({
      number: 'x'.repeat(64),
      cvv: '123',
      expiry: '12/27',
      brand: 'Visa',
    });
    assert.equal(sealed.number, 'x'.repeat(64));
  });
});

describe('card-vault — F3 whitespace-only rejection', () => {
  const reload = () => {
    delete require.cache[require.resolve('../../src/lib/secret-box')];
    delete require.cache[require.resolve('../../src/lib/card-vault')];
    return require('../../src/lib/card-vault');
  };

  it('rejects a space-only number', () => {
    const { sealCard } = reload();
    assert.throws(
      () => sealCard({ number: '   ', cvv: '123', expiry: '12/27', brand: 'Visa' }),
      /card-vault: cannot seal number: whitespace-only value/,
    );
  });

  it('rejects a tab-only cvv', () => {
    const { sealCard } = reload();
    assert.throws(
      () => sealCard({ number: '4111', cvv: '\t\t', expiry: '12/27', brand: 'Visa' }),
      /card-vault: cannot seal cvv: whitespace-only value/,
    );
  });

  it('rejects mixed whitespace in expiry', () => {
    const { sealCard } = reload();
    assert.throws(
      () => sealCard({ number: '4111', cvv: '123', expiry: ' \t\n ', brand: 'Visa' }),
      /card-vault: cannot seal expiry: whitespace-only value/,
    );
  });

  it('accepts values with internal whitespace (paranoid but allowed)', () => {
    // "12 / 27" — unusual but non-empty after trim. The function
    // only rejects values that are ENTIRELY whitespace. Real card
    // fields shouldn't have internal whitespace but rejecting it
    // is a judgement call; current behaviour is to permit and let
    // downstream validation handle it.
    const { sealCard } = reload();
    const sealed = sealCard({
      number: '4111111111111111',
      cvv: '123',
      expiry: '12 / 27',
      brand: 'Visa',
    });
    assert.equal(sealed.expiry, '12 / 27');
  });
});
