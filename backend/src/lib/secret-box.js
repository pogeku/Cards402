// @ts-check
// Small AES-256-GCM "secret box" used for at-rest encryption of
// short-lived secrets (agent claim payloads, VCC tokens, etc.).
//
// Format: "enc:<iv_hex>:<tag_hex>:<ciphertext_hex>"
//
// Key source: first of these env vars that is set —
//   CARDS402_SECRET_BOX_KEY  (preferred, new)
//   VCC_TOKEN_KEY            (legacy, kept for backwards-compat)
// Each must be a 32-byte (64-hex) random value. Generate with:
//   openssl rand -hex 32
//
// If no key is configured, behaviour depends on NODE_ENV:
//
//   production → seal() throws. Silent plaintext fallback in prod is how
//                claim payloads (raw api keys + webhook secrets) ended up
//                stored plaintext in the 2026-04-13 adversarial audit
//                (finding F5). The claim endpoint's entire purpose is to
//                keep raw keys out of the DB and the chat transcript; if
//                the key is missing in prod, we refuse to seal at all so
//                the error surfaces at mint time rather than at restore.
//
//   test / dev → seal() returns plaintext (with a one-time warning). Local
//                workflows and the test suite don't set the key and
//                shouldn't need to.

const crypto = require('crypto');

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

// F1 fix: strict-validate any key env var that is set, regardless of
// whether it's the preferred or the legacy name. env.js already
// validates CARDS402_SECRET_BOX_KEY via zod, but the legacy
// VCC_TOKEN_KEY name is not enumerated in the schema — so a typo
// (wrong length or non-hex chars) would silently fall through to the
// dev/test plaintext-fallback path and the operator would think
// encryption was enabled when it wasn't. Validating at module load
// means the next seal()/open() call sees a hard failure rather than a
// confusing silent downgrade.
//
// F2: if both names are set to DIFFERENT values, warn loudly. Operators
// rotating by adding a new var without unsetting the old one otherwise
// get no signal that their rotation didn't cover the legacy fallback.
function loadKeyFromEnv() {
  const preferred = process.env.CARDS402_SECRET_BOX_KEY;
  const legacy = process.env.VCC_TOKEN_KEY;
  for (const [name, val] of [
    ['CARDS402_SECRET_BOX_KEY', preferred],
    ['VCC_TOKEN_KEY', legacy],
  ]) {
    if (val && !KEY_HEX_RE.test(val)) {
      throw new Error(
        `secret-box: ${name} must be 64 hex characters (32 bytes). ` +
          `Generate one with \`openssl rand -hex 32\`.`,
      );
    }
  }
  if (preferred && legacy && preferred !== legacy) {
    console.warn(
      '[secret-box] both CARDS402_SECRET_BOX_KEY and VCC_TOKEN_KEY are set ' +
        'to different values — using CARDS402_SECRET_BOX_KEY. Unset the ' +
        'legacy VCC_TOKEN_KEY to remove this warning.',
    );
  }
  const hex = preferred || legacy;
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

function getKey() {
  // Re-read the env on every call so tests that mutate process.env
  // between cases see fresh values. The validation loop above is
  // cheap — two regex tests and a string compare.
  return loadKeyFromEnv();
}

let warnedAboutMissingKey = false;

/**
 * Seal a plaintext secret. Returns the stored form; idempotent for
 * already-sealed values. Throws in production when no key is configured
 * so callers cannot accidentally persist plaintext credentials.
 * @param {string} plaintext
 */
function seal(plaintext) {
  if (typeof plaintext !== 'string') throw new Error('seal: plaintext must be a string');
  if (plaintext.startsWith('enc:')) return plaintext; // already sealed
  const key = getKey();
  if (!key) {
    if (isProduction()) {
      throw new Error(
        'secret-box: CARDS402_SECRET_BOX_KEY is required in production. ' +
          'Generate one with `openssl rand -hex 32` and set it in the environment ' +
          'before restarting the backend.',
      );
    }
    if (!warnedAboutMissingKey) {
      console.warn(
        '[secret-box] CARDS402_SECRET_BOX_KEY not set — sealing as plaintext (dev/test only)',
      );
      warnedAboutMissingKey = true;
    }
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Open a sealed secret. Returns the plaintext. Pass-through for
 * non-sealed values (so old plaintext rows on upgrade still work).
 * Throws on tampered ciphertext via the GCM tag check, and on
 * malformed stored blobs before reaching the crypto layer so the
 * caller sees a clear "malformed sealed blob" error instead of a
 * generic `Buffer.from: first argument must be of type string`.
 * @param {string} stored
 */
function open(stored) {
  if (typeof stored !== 'string') throw new Error('open: stored must be a string');
  if (!stored.startsWith('enc:')) return stored;
  const key = getKey();
  if (!key) {
    throw new Error(
      'secret-box: CARDS402_SECRET_BOX_KEY not set, cannot decrypt. Generate one with `openssl rand -hex 32` and set it in the environment.',
    );
  }
  // Expected format: enc:<iv_hex>:<tag_hex>:<ct_hex> — exactly four
  // colon-separated parts, each the middle three being pure hex. A
  // truncated row (common failure mode for a half-written UPDATE or a
  // partial restore) used to land in Buffer.from(undefined, 'hex') and
  // throw an opaque TypeError; validate the shape here so the caller
  // sees a specific "malformed sealed blob" error and can handle it
  // (log the row, surface a 500 with context, skip the row, etc.).
  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error(
      `secret-box: malformed sealed blob (expected 4 colon-separated parts, got ${parts.length})`,
    );
  }
  const [, ivHex, tagHex, ctHex] = parts;
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(tagHex) || !/^[0-9a-f]*$/i.test(ctHex)) {
    throw new Error('secret-box: malformed sealed blob (non-hex characters in iv/tag/ciphertext)');
  }
  // Crypto layer enforces IV length (12 bytes = 24 hex) and tag length
  // (16 bytes = 32 hex) so we don't need to pre-check those; they'll
  // surface as InvalidArgument / InvalidTagLength errors which are
  // distinguishable in ops logs from the shape-mismatch case above.
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

/** True if a box key is configured (so callers can refuse to seal plaintext in prod). */
function hasKey() {
  return getKey() !== null;
}

module.exports = { seal, open, hasKey };
