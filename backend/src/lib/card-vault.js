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
 * @param {{number?: string|null, cvv?: string|null, expiry?: string|null, brand?: string|null}} card
 */
function sealCard(card) {
  return {
    number: card.number ? seal(card.number) : null,
    cvv: card.cvv ? seal(card.cvv) : null,
    expiry: card.expiry ? seal(card.expiry) : null,
    brand: card.brand ?? null,
  };
}

/**
 * Open a card row read out of the orders table. Accepts both the legacy
 * column shape (`{ card_number, card_cvv, card_expiry, card_brand }`) and
 * the agent-facing camel shape so callers don't have to remap.
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
    number: number ? open(number) : null,
    cvv: cvv ? open(cvv) : null,
    expiry: expiry ? open(expiry) : null,
    brand,
  };
}

module.exports = { sealCard, openCard, vaultEnabled: hasKey };
