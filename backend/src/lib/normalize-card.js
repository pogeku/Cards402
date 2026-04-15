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
//
// Adversarial audit 2026-04-15:
//
//   F1-normalize-card: whitespace-only input no longer masquerades as
//     'USD Prepaid Card'. Pre-fix, `'   '.toLowerCase()` was a valid
//     truthy string, no substring matched, and the function returned
//     the cheerful 'USD Prepaid Card' fallback — hiding upstream data
//     corruption behind a plausible-looking label that the agent and
//     the dashboard would both accept. Now the input is trimmed before
//     matching; a whitespace-only string returns null just like empty
//     input does, surfacing the corruption to the caller.
//
//   F2-normalize-card: the unknown-scheme fallback used to be silent.
//     The inline comment said "ops needs to know we're seeing a new
//     merchant" but no logging actually fired — when CTX introduced a
//     new product SKU or renamed an existing one, the agent silently
//     saw 'USD Prepaid Card' and ops had no signal until a support
//     ticket came in. Now the fallback emits a dedup'd
//     bizEvent('normalize_card.unknown_brand', { raw }) + one-shot
//     console.warn per unique raw value per process. Same dedup
//     pattern as agent-state's unknown-state warn: first sight of
//     each distinct offender logs once, repeated sightings are
//     suppressed so one bad row doesn't spam the log.

// F2-normalize-card: dedup so the same unknown brand across hundreds of
// cards emits exactly one warn + one bizEvent per process lifetime.
const _warnedUnknownBrands = new Set();

// Lazy-loaded bizEvent so this module stays a leaf — logger.js already
// imports no card logic, but we avoid coupling just in case.
let _bizEvent = null;
function safeBizEvent(name, fields) {
  try {
    if (!_bizEvent) _bizEvent = require('./logger').event;
    _bizEvent(name, fields);
  } catch {
    /* intentional — observability must not block the gate */
  }
}

/**
 * @param {string|null|undefined} rawBrand
 * @returns {string|null}
 */
function normalizeCardBrand(rawBrand) {
  if (!rawBrand || typeof rawBrand !== 'string') return null;

  // F1-normalize-card: trim before any matching. A whitespace-only input
  // after trim is empty → null, not the 'USD Prepaid Card' fallback.
  const trimmed = rawBrand.trim();
  if (trimmed.length === 0) return null;

  const lower = trimmed.toLowerCase();
  if (lower.includes('visa')) return 'USD Visa Card';
  if (lower.includes('master')) return 'USD Mastercard';
  if (lower.includes('amex') || lower.includes('american express')) return 'USD Amex Card';
  if (lower.includes('discover')) return 'USD Discover Card';

  // F2-normalize-card: unknown scheme. Emit a loud-but-dedup'd signal so
  // ops sees new CTX product strings the first time they appear. Dedup'd
  // on the raw (pre-trim) value so a trailing-whitespace variant and its
  // clean sibling both register as "same offender" without spam.
  if (!_warnedUnknownBrands.has(trimmed)) {
    _warnedUnknownBrands.add(trimmed);
    console.warn(
      `[normalize-card] unknown brand ${JSON.stringify(trimmed)} — ` +
        `rendering as 'USD Prepaid Card'. Add a rule if this is a new merchant.`,
    );
    safeBizEvent('normalize_card.unknown_brand', { raw: trimmed });
  }
  return 'USD Prepaid Card';
}

/**
 * Test-only: reset the dedup cache so each case starts fresh.
 */
function _resetWarnedBrands() {
  _warnedUnknownBrands.clear();
}

module.exports = { normalizeCardBrand, _resetWarnedBrands };
