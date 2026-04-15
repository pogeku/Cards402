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

// Adversarial audit F1-secret-box (2026-04-15): strict regex for the
// "already sealed" idempotency check in seal(). The previous impl
// used `startsWith('enc:')`, so a plaintext value that happened to
// start with "enc:" (e.g. "enc:my_secret_payload") was returned
// verbatim instead of being encrypted. The caller would think the
// value was sealed, but the DB would hold plaintext. No current
// call site passes such input, but the check should verify the
// full format of a real sealed blob rather than just the marker
// prefix. A match requires the enc: literal plus three
// colon-separated hex fields — exactly the shape seal() produces.
const SEALED_BLOB_RE = /^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]*$/i;

// Adversarial audit F2-secret-box (2026-04-15): AES-256-GCM uses
// a 12-byte IV (24 hex chars) and a 16-byte authentication tag
// (32 hex chars). These are CONSTANT for every blob this module
// produces — seal() always generates crypto.randomBytes(12) for
// the IV and AES-GCM always emits a 16-byte tag at authTagLength:
// 16. The open() path must enforce both lengths BEFORE calling
// setAuthTag, because Node's setAuthTag passes through to OpenSSL's
// EVP_CTRL_GCM_SET_TAG which accepts any tag length from 4 to 16
// bytes and silently downgrades authentication strength to match.
// A sealed blob with a 4-byte tag (`enc:<iv>:<4-byte-tag>:<ct>`)
// would be accepted by the old code and authenticated at 32-bit
// strength — forgeable with ~2^32 attempts. The previous code
// comment claimed "Crypto layer enforces IV length / tag length"
// but that claim was incorrect for Node's setAuthTag surface.
// Making it true with explicit length checks.
const IV_HEX_LEN = 24; // 12 bytes
const TAG_HEX_LEN = 32; // 16 bytes

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
  // F1-secret-box: full-format idempotency check. A plaintext that
  // merely starts with "enc:" is NOT a sealed blob and MUST be
  // encrypted, not returned verbatim. SEALED_BLOB_RE requires the
  // four-part colon-separated hex shape seal() actually produces.
  if (SEALED_BLOB_RE.test(plaintext)) return plaintext; // already sealed
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
  // F2-secret-box: enforce exact IV (12 bytes / 24 hex) and tag
  // (16 bytes / 32 hex) lengths before handing off to setAuthTag.
  // Node's setAuthTag passes through to OpenSSL which accepts any
  // GCM tag length from 4-16 bytes and silently downgrades the
  // authentication strength to match — a 4-byte tag drops forgery
  // resistance from 2^128 to 2^32. The previous comment here
  // claimed the crypto layer enforced these lengths, but it does
  // not for setAuthTag. Make the claim true at this layer.
  if (ivHex.length !== IV_HEX_LEN) {
    throw new Error(
      `secret-box: malformed sealed blob (IV is ${ivHex.length / 2} bytes, expected 12)`,
    );
  }
  if (tagHex.length !== TAG_HEX_LEN) {
    throw new Error(
      `secret-box: malformed sealed blob (auth tag is ${tagHex.length / 2} bytes, expected 16)`,
    );
  }
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
