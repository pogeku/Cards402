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

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getKey() {
  const hex = process.env.CARDS402_SECRET_BOX_KEY || process.env.VCC_TOKEN_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
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
 * Throws on tampered ciphertext via the GCM tag check.
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
  const [, ivHex, tagHex, ctHex] = stored.split(':');
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
