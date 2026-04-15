// Unit tests for lib/secret-box — AES-256-GCM at-rest encryption.
// Covers the happy path (seal/open round-trip), the backwards-compat
// plaintext-passthrough, and the strict-validation + warning behaviour
// added in the 2026-04-15 audit.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SECRET_BOX_PATH = require.resolve('../../src/lib/secret-box');

function freshModule() {
  delete require.cache[SECRET_BOX_PATH];
  return require('../../src/lib/secret-box');
}

const GOOD_KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const BAD_KEY_SHORT = 'a'.repeat(63);
const BAD_KEY_NONHEX = 'z'.repeat(64);

describe('secret-box — happy path', () => {
  let origPreferred;
  let origLegacy;

  beforeEach(() => {
    origPreferred = process.env.CARDS402_SECRET_BOX_KEY;
    origLegacy = process.env.VCC_TOKEN_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = GOOD_KEY;
    delete process.env.VCC_TOKEN_KEY;
  });

  afterEach(() => {
    if (origPreferred === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
    else process.env.CARDS402_SECRET_BOX_KEY = origPreferred;
    if (origLegacy === undefined) delete process.env.VCC_TOKEN_KEY;
    else process.env.VCC_TOKEN_KEY = origLegacy;
  });

  it('seals and opens a round-trip', () => {
    const box = freshModule();
    const sealed = box.seal('super secret');
    assert.ok(sealed.startsWith('enc:'), 'sealed value must carry the enc: envelope');
    assert.equal(box.open(sealed), 'super secret');
  });

  it('seal is idempotent — already-sealed values pass through', () => {
    const box = freshModule();
    const sealed = box.seal('x');
    assert.equal(box.seal(sealed), sealed);
  });

  it('open is pass-through for non-sealed legacy plaintext rows', () => {
    const box = freshModule();
    assert.equal(box.open('legacy plaintext'), 'legacy plaintext');
  });

  it('hasKey returns true when a valid key is configured', () => {
    const box = freshModule();
    assert.equal(box.hasKey(), true);
  });
});

describe('secret-box — strict key validation (F1)', () => {
  let origPreferred;
  let origLegacy;

  beforeEach(() => {
    origPreferred = process.env.CARDS402_SECRET_BOX_KEY;
    origLegacy = process.env.VCC_TOKEN_KEY;
  });

  afterEach(() => {
    if (origPreferred === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
    else process.env.CARDS402_SECRET_BOX_KEY = origPreferred;
    if (origLegacy === undefined) delete process.env.VCC_TOKEN_KEY;
    else process.env.VCC_TOKEN_KEY = origLegacy;
  });

  it('rejects a short CARDS402_SECRET_BOX_KEY with a specific error', () => {
    delete process.env.VCC_TOKEN_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = BAD_KEY_SHORT;
    const box = freshModule();
    assert.throws(() => box.seal('x'), /CARDS402_SECRET_BOX_KEY must be 64 hex/);
  });

  it('rejects a non-hex CARDS402_SECRET_BOX_KEY with a specific error', () => {
    delete process.env.VCC_TOKEN_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = BAD_KEY_NONHEX;
    const box = freshModule();
    assert.throws(() => box.seal('x'), /CARDS402_SECRET_BOX_KEY must be 64 hex/);
  });

  it('rejects a malformed VCC_TOKEN_KEY legacy fallback (regression guard)', () => {
    // This is the primary F1-secret-box finding: env.js validates the
    // preferred name but NOT the legacy one, so a typo in VCC_TOKEN_KEY
    // previously fell through to silent plaintext fallback.
    delete process.env.CARDS402_SECRET_BOX_KEY;
    process.env.VCC_TOKEN_KEY = BAD_KEY_SHORT;
    const box = freshModule();
    assert.throws(() => box.seal('x'), /VCC_TOKEN_KEY must be 64 hex/);
  });

  it('hasKey throws when a key env var is set but malformed', () => {
    delete process.env.CARDS402_SECRET_BOX_KEY;
    process.env.VCC_TOKEN_KEY = BAD_KEY_NONHEX;
    const box = freshModule();
    assert.throws(() => box.hasKey(), /VCC_TOKEN_KEY must be 64 hex/);
  });
});

describe('secret-box — split-value warning (F2)', () => {
  let origPreferred;
  let origLegacy;
  let origWarn;
  let warnings;

  beforeEach(() => {
    origPreferred = process.env.CARDS402_SECRET_BOX_KEY;
    origLegacy = process.env.VCC_TOKEN_KEY;
    origWarn = console.warn;
    warnings = [];
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.warn = origWarn;
    if (origPreferred === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
    else process.env.CARDS402_SECRET_BOX_KEY = origPreferred;
    if (origLegacy === undefined) delete process.env.VCC_TOKEN_KEY;
    else process.env.VCC_TOKEN_KEY = origLegacy;
  });

  it('warns when both env vars are set to different values', () => {
    process.env.CARDS402_SECRET_BOX_KEY = GOOD_KEY;
    process.env.VCC_TOKEN_KEY = OTHER_KEY;
    const box = freshModule();
    // Force the key load via seal().
    const sealed = box.seal('hello');
    // Opens with the preferred key, proving the preferred key won the tie.
    assert.equal(box.open(sealed), 'hello');
    assert.ok(
      warnings.some((w) => /both CARDS402_SECRET_BOX_KEY and VCC_TOKEN_KEY/.test(w)),
      `expected split-value warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('does NOT warn when both vars are set to the same value', () => {
    process.env.CARDS402_SECRET_BOX_KEY = GOOD_KEY;
    process.env.VCC_TOKEN_KEY = GOOD_KEY;
    const box = freshModule();
    box.seal('hello');
    assert.ok(
      !warnings.some((w) => /both CARDS402_SECRET_BOX_KEY and VCC_TOKEN_KEY/.test(w)),
      `should not warn for identical values, got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ── F1-secret-box (2026-04-15): strict idempotency regex ───────────
//
// The previous seal() check was `startsWith('enc:')` which returned
// any value starting with "enc:" unchanged — even a plaintext like
// "enc:my_secret" that should have been properly encrypted. A future
// caller that passes user-controlled data (or data derived from a
// column that happens to start with "enc:") would silently store
// plaintext. The fix requires the full three-colon hex shape that
// real sealed blobs have, so partial matches get encrypted.

describe('secret-box — F1 strict seal idempotency', () => {
  let origPreferred;
  let origLegacy;
  beforeEach(() => {
    origPreferred = process.env.CARDS402_SECRET_BOX_KEY;
    origLegacy = process.env.VCC_TOKEN_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = GOOD_KEY;
    delete process.env.VCC_TOKEN_KEY;
  });
  afterEach(() => {
    if (origPreferred === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
    else process.env.CARDS402_SECRET_BOX_KEY = origPreferred;
    if (origLegacy === undefined) delete process.env.VCC_TOKEN_KEY;
    else process.env.VCC_TOKEN_KEY = origLegacy;
  });

  it('seals a plaintext that happens to start with "enc:" (not a pass-through)', () => {
    // Pre-fix: `startsWith('enc:')` → return unchanged → plaintext
    // stored verbatim. Post-fix: SEALED_BLOB_RE requires the full
    // enc:<hex>:<hex>:<hex> format, so this plaintext is properly
    // encrypted.
    const box = freshModule();
    const plaintext = 'enc:my_fake_secret_payload';
    const sealed = box.seal(plaintext);
    // A truly-sealed value is a DIFFERENT string (fresh IV/tag/ct).
    assert.notEqual(sealed, plaintext);
    assert.ok(sealed.startsWith('enc:'));
    // Round-trip: open the sealed value and get back the original
    // plaintext exactly.
    assert.equal(box.open(sealed), plaintext);
  });

  it('seals a plaintext that starts with "enc:" but has no colons', () => {
    const box = freshModule();
    const plaintext = 'encZZZ no colons at all';
    const sealed = box.seal(plaintext);
    assert.notEqual(sealed, plaintext);
    assert.equal(box.open(sealed), plaintext);
  });

  it('seals a plaintext with exactly two colons (not three)', () => {
    // Pre-fix: `startsWith('enc:')` passed, length check didn't
    // apply at seal time, value returned as-is.
    const box = freshModule();
    const plaintext = 'enc:aa:bb'; // only 2 colons after "enc:"
    const sealed = box.seal(plaintext);
    assert.notEqual(sealed, plaintext);
    assert.equal(box.open(sealed), plaintext);
  });

  it('still idempotent for a properly-formed sealed blob', () => {
    // Regression guard: the idempotency property must be preserved
    // for real sealed values. Re-sealing should return the same blob.
    const box = freshModule();
    const sealed = box.seal('hello');
    const resealed = box.seal(sealed);
    assert.equal(resealed, sealed, 'real sealed blobs are still idempotent');
  });
});

// ── F2-secret-box (2026-04-15): explicit IV/tag length validation ──
//
// Node's setAuthTag passes through to OpenSSL's EVP_CTRL_GCM_SET_TAG
// which accepts GCM tags of any length from 4-16 bytes and silently
// downgrades authentication strength to match. A sealed blob with a
// 4-byte tag drops forgery resistance from 2^128 to 2^32 — trivially
// forgeable. open() now enforces exact lengths before setAuthTag so
// the downgrade surface is closed at the app layer.

describe('secret-box — F2 IV/tag length validation', () => {
  let origPreferred;
  let origLegacy;
  beforeEach(() => {
    origPreferred = process.env.CARDS402_SECRET_BOX_KEY;
    origLegacy = process.env.VCC_TOKEN_KEY;
    process.env.CARDS402_SECRET_BOX_KEY = GOOD_KEY;
    delete process.env.VCC_TOKEN_KEY;
  });
  afterEach(() => {
    if (origPreferred === undefined) delete process.env.CARDS402_SECRET_BOX_KEY;
    else process.env.CARDS402_SECRET_BOX_KEY = origPreferred;
    if (origLegacy === undefined) delete process.env.VCC_TOKEN_KEY;
    else process.env.VCC_TOKEN_KEY = origLegacy;
  });

  it('rejects a sealed blob with a short (4-byte) tag', () => {
    const box = freshModule();
    // Craft a blob with a 12-byte IV (24 hex) and a 4-byte tag (8 hex).
    // The ciphertext is arbitrary hex.
    const shortTagBlob = `enc:${'aa'.repeat(12)}:${'bb'.repeat(4)}:${'cc'.repeat(16)}`;
    assert.throws(
      () => box.open(shortTagBlob),
      /auth tag is 4 bytes, expected 16/,
      'must reject short-tag blob before calling setAuthTag',
    );
  });

  it('rejects a sealed blob with an 8-byte tag', () => {
    const box = freshModule();
    const blob = `enc:${'aa'.repeat(12)}:${'bb'.repeat(8)}:${'cc'.repeat(16)}`;
    assert.throws(() => box.open(blob), /auth tag is 8 bytes, expected 16/);
  });

  it('rejects a sealed blob with an oversize (20-byte) tag', () => {
    const box = freshModule();
    const blob = `enc:${'aa'.repeat(12)}:${'bb'.repeat(20)}:${'cc'.repeat(16)}`;
    assert.throws(() => box.open(blob), /auth tag is 20 bytes, expected 16/);
  });

  it('rejects a sealed blob with a short (8-byte) IV', () => {
    const box = freshModule();
    const blob = `enc:${'aa'.repeat(8)}:${'bb'.repeat(16)}:${'cc'.repeat(16)}`;
    assert.throws(() => box.open(blob), /IV is 8 bytes, expected 12/);
  });

  it('rejects a sealed blob with an oversize (16-byte) IV', () => {
    const box = freshModule();
    const blob = `enc:${'aa'.repeat(16)}:${'bb'.repeat(16)}:${'cc'.repeat(16)}`;
    assert.throws(() => box.open(blob), /IV is 16 bytes, expected 12/);
  });

  it('accepts a well-formed seal/open round-trip (regression guard)', () => {
    // The length-length-length gauntlet must not reject legitimate
    // values. seal() always produces 12-byte IV and 16-byte tag.
    const box = freshModule();
    const sealed = box.seal('sensitive-data');
    assert.equal(box.open(sealed), 'sensitive-data');
  });

  it('error path fires BEFORE any crypto state is created', () => {
    // The length check must short-circuit without constructing a
    // decipher. A broken blob should fail cheaply and not leak any
    // partial decrypt state to the caller.
    const box = freshModule();
    const blob = `enc:${'aa'.repeat(12)}:${'bb'.repeat(4)}:${'cc'.repeat(16)}`;
    let err;
    try {
      box.open(blob);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    // The error message must be the length-check message, not a
    // GCM internal (which would indicate setAuthTag was still
    // invoked, defeating the whole point of the length check).
    assert.match(err.message, /auth tag is 4 bytes/);
    assert.doesNotMatch(err.message, /Invalid authentication tag/);
    assert.doesNotMatch(err.message, /unable to authenticate/);
  });
});
