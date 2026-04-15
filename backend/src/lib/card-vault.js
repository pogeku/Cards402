// @ts-check
// Card-data sealing wrapper around lib/secret-box.
//
// Adversarial audit F1: card_number / card_cvv / card_expiry were stored
// plaintext in the orders table, doubling the at-rest blast radius of any
// DB compromise (vcc already encrypts its copy with AES-256-GCM). This
// helper centralises seal/open for the three sensitive fields so every
// write path uses the same vault and every read path can decrypt
// transparently.
//
// In production, secret-box.seal() throws when CARDS402_SECRET_BOX_KEY is
// unset (audit F5), so card writes will fail loudly rather than silently
// persisting plaintext. In dev/test the seal is a no-op and rows stay
// plaintext; lib/secret-box.open() pass-through handles that case
// transparently when reading.

const { seal, open, hasKey } = require('./secret-box');

/**
 * Seal the three sensitive card fields. card_brand is not sensitive
 * (Visa, Mastercard) and is left as-is. `null` / `undefined` inputs are
 * preserved so callers can pass partial card payloads without branching.
 *
 * Empty strings and non-string types for number/cvv/expiry are rejected
 * with a specific card-vault error rather than silently mapped to null.
 * A VCC response-parser regression yielding `{number: ""}` previously
 * passed the falsy check and stored null, making it look like the card
 * was correctly sealed when in fact no card data was preserved at all —
 * the order would then flip to `delivered` with empty fields and the
 * agent would see "card issued" with nothing usable, after funds were
 * already spent (no refund because status is terminal). Adversarial
 * audit F1-card-vault.
 *
 * @param {{number?: string|null, cvv?: string|null, expiry?: string|null, brand?: string|null}} card
 */
function sealCard(card) {
  // Adversarial audit F1-card-vault-2 (2026-04-15): explicit input
  // guard. Previously sealCard(null) and sealCard(undefined) crashed
  // with `TypeError: Cannot read properties of null (reading 'number')`
  // — every caller currently gates with `if (card)` upstream so the
  // crash is latent, but a future refactor that drops the guard
  // would turn into a 500 on every delivery. Throw a specific,
  // greppable error instead of relying on the JS engine's TypeError
  // to surface the bug at review time.
  if (card === null || card === undefined) {
    throw new Error('card-vault: sealCard called with null/undefined — caller must guard');
  }
  if (typeof card !== 'object' || Array.isArray(card)) {
    throw new Error(
      `card-vault: sealCard expected a plain object, got ${Array.isArray(card) ? 'array' : typeof card}`,
    );
  }
  return {
    number: sealField('number', card.number),
    cvv: sealField('cvv', card.cvv),
    expiry: sealField('expiry', card.expiry),
    brand: card.brand ?? null,
  };
}

// Adversarial audit F2-card-vault (2026-04-15): per-field maximum
// byte length. Real card fields have a very predictable ceiling —
// PANs are 13-19 digits (19 bytes max), CVVs are 3-4 digits,
// expiries are 5-7 chars (MM/YY or MM/YYYY). The old sealField
// accepted any non-empty string, so a buggy upstream sending a
// 10KB card_number would seal and store 10KB of encrypted garbage.
// 64 bytes is ~3x the largest legitimate value and bounds the
// DB-bloat / memory-pressure blast radius of an upstream parser
// regression.
const MAX_FIELD_BYTES = 64;

/**
 * Validate and seal a single card field. `null`/`undefined` → `null`
 * (partial-card ok). Anything else must be a non-empty, non-whitespace
 * string under MAX_FIELD_BYTES bytes.
 * @param {string} fieldName
 * @param {unknown} value
 */
function sealField(fieldName, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`card-vault: cannot seal ${fieldName}: expected string, got ${typeof value}`);
  }
  if (value.length === 0) {
    throw new Error(
      `card-vault: cannot seal ${fieldName}: empty string (pass null for an absent field)`,
    );
  }
  // F3-card-vault (2026-04-15): reject whitespace-only strings with
  // the same fail-loud story as the existing empty-string rejection.
  // An upstream parser glitch yielding `{number: '   '}` previously
  // passed the length check, sealed the whitespace, and delivered a
  // "valid" card with garbage the agent can't use — and once the
  // order flips to `delivered` there's no refund path. Reject here
  // so the delivery never lands.
  if (value.trim().length === 0) {
    throw new Error(
      `card-vault: cannot seal ${fieldName}: whitespace-only value (pass null for an absent field)`,
    );
  }
  // F2-card-vault (2026-04-15): byte-length cap.
  const byteLen = Buffer.byteLength(value, 'utf8');
  if (byteLen > MAX_FIELD_BYTES) {
    throw new Error(
      `card-vault: cannot seal ${fieldName}: value is ${byteLen} bytes, max ${MAX_FIELD_BYTES}`,
    );
  }
  return seal(value);
}

/**
 * Open a card row read out of the orders table. Accepts both the legacy
 * column shape (`{ card_number, card_cvv, card_expiry, card_brand }`) and
 * the agent-facing camel shape so callers don't have to remap.
 *
 * If any field's decryption fails (GCM tag mismatch, truncated blob,
 * key mismatch after a rotation), the error is re-thrown with the
 * field name prefixed so ops can pinpoint which field of which order
 * is broken — the underlying GCM error is generic ("unable to
 * authenticate data") and without context is painful to triage.
 *
 * @param {Record<string, any>} row
 */
function openCard(row) {
  if (!row) return null;
  const number = row.card_number ?? row.number ?? null;
  const cvv = row.card_cvv ?? row.cvv ?? null;
  const expiry = row.card_expiry ?? row.expiry ?? null;
  const brand = row.card_brand ?? row.brand ?? null;
  return {
    number: safeOpen('card_number', number),
    cvv: safeOpen('card_cvv', cvv),
    expiry: safeOpen('card_expiry', expiry),
    brand,
  };
}

function safeOpen(fieldName, value) {
  if (!value) return null;
  try {
    return open(value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`card-vault: failed to open ${fieldName}: ${msg}`);
    // Preserve the original for ops traceability without exposing it
    // to agents — callers that JSON-serialise the error get the
    // prefixed message, not the raw GCM noise.
    /** @type {any} */ (wrapped).cause = err;
    /** @type {any} */ (wrapped).field = fieldName;
    throw wrapped;
  }
}

module.exports = { sealCard, openCard, vaultEnabled: hasKey };
