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
