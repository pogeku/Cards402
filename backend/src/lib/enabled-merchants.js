// @ts-check
// Enabled-merchants catalog. We deliberately expose only the gift-card
// products cards402 has onboarded (currently just the Visa eReward
// card). Later this becomes a DB table fed from an admin UI; for now
// it's a small static array so the frontend can render a proper list
// without a cross-service call to CTX on every hit.
//
// Data for each entry is a mirror of the canonical CTX merchant record
// so frontend rendering doesn't need to understand CTX specifics.

/**
 * @typedef {Object} EnabledMerchant
 * @property {string} id                 upstream merchant id (maps to CTX_MERCHANT_ID)
 * @property {string} name
 * @property {string} logo_url
 * @property {string} card_image_url
 * @property {string} country
 * @property {string} currency
 * @property {number} min_amount
 * @property {number} max_amount
 * @property {'online' | 'in_store' | 'both'} redeem_location
 * @property {'barcode' | 'code' | 'link'} redeem_type
 * @property {boolean} enabled
 * @property {string} description
 */

/** @type {EnabledMerchant[]} */
const ENABLED_MERCHANTS = [
  {
    id: 'a6c7a007-016b-4f90-9180-0a173cfeaf57',
    name: 'Visa® eReward Card',
    logo_url: 'https://ctx-spend.s3.us-west-2.amazonaws.com/0/visa-ereward-logo',
    card_image_url: 'https://ctx-spend.s3.us-west-2.amazonaws.com/0/visa-ereward-card',
    country: 'US',
    currency: 'USD',
    min_amount: 5,
    max_amount: 500,
    redeem_location: 'online',
    redeem_type: 'link',
    enabled: true,
    description:
      'General-purpose Visa virtual card accepted anywhere Visa is. Issued instantly after payment.',
  },
];

function listEnabledMerchants() {
  return ENABLED_MERCHANTS.filter((m) => m.enabled);
}

/**
 * @param {string} id
 */
function getEnabledMerchant(id) {
  return ENABLED_MERCHANTS.find((m) => m.id === id && m.enabled) || null;
}

/**
 * @param {string} id
 */
function isMerchantEnabled(id) {
  return getEnabledMerchant(id) !== null;
}

module.exports = {
  ENABLED_MERCHANTS,
  listEnabledMerchants,
  getEnabledMerchant,
  isMerchantEnabled,
};
