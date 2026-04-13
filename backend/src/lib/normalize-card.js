// @ts-check
// Normalise the upstream card brand string before it's surfaced to agents.
//
// vcc/CTX returns brand strings like:
//   "Visa® Reward Card, 6-Month Expiration [ITNL] eGift Card"
//   "Mastercard® Prepaid"
//   "American Express Gift Card"
// which leak the upstream merchant catalog and CTX's internal SKU naming
// into the agent's transcript. The audit-F4 sanitisation principle says
// agents should see a stable label, never the internal product string.
//
// Rule: pattern-match on the raw brand for the card scheme + return
// "<currency> <scheme> Card". Currency is fixed to USD because every
// merchant in enabled-merchants.js is currently US/USD; if we onboard a
// non-USD merchant in the future we'll plumb the currency through from
// the order row and look it up here.

/** @param {string|null|undefined} rawBrand */
function normalizeCardBrand(rawBrand) {
  if (!rawBrand || typeof rawBrand !== 'string') return null;
  const lower = rawBrand.toLowerCase();
  if (lower.includes('visa')) return 'USD Visa Card';
  if (lower.includes('master')) return 'USD Mastercard';
  if (lower.includes('amex') || lower.includes('american express')) return 'USD Amex Card';
  if (lower.includes('discover')) return 'USD Discover Card';
  // Unknown scheme — return a neutral label rather than the raw upstream
  // string. Logging the raw value is fine (ops needs to know we're seeing
  // a new merchant) but agents must not see it.
  return 'USD Prepaid Card';
}

module.exports = { normalizeCardBrand };
