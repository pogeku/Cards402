// @ts-check
// XLM/USD price from CTX rates API — ctx-average source.
//
// Hardened by the 2026-04-15 adversarial audit:
//
//   F1  Short-TTL in-memory cache. Previously every POST /v1/orders did
//       a synchronous HTTP round trip to rates.ctx.com, exposing us to
//       CTX rate limits, making CTX a single point of failure for order
//       creation, and amplifying a /v1/orders DoS into a CTX-quota DoS.
//       30s is well below XLM price volatility at the per-order level
//       and payment-handler enforces exact equality against the quoted
//       value so our exposure is bounded by the cache window.
//
//   F2  Sanity bounds on the returned price. XLM/USD has lived in
//       [$0.01, $1.00] since inception; anything outside is obvious
//       garbage from a parser bug or a compromised upstream. Reject
//       rather than letting "XLM at $999999" silently price an order
//       at near-zero XLM.
//
//   F3  Strict input validation in usdToXlm so a standalone caller
//       can't accidentally produce "NaN" strings as payment quotes.
//
//   F4  Explicit array check on the upstream response so an API shape
//       change surfaces as a specific error instead of a cryptic
//       TypeError inside .find().

const { event: bizEvent } = require('../lib/logger');

const RATES_URL = 'https://rates.ctx.com/rates?symbol=xlmusd';

// XLM/USD sanity bounds. Historical range is ~$0.01 to ~$1.00; we
// widen both sides by an order of magnitude so a transient market
// spike (2021 peak was ~$0.79) doesn't trip the guard, while still
// catching parser / upstream errors.
const MIN_SANE_PRICE = 0.001;
const MAX_SANE_PRICE = 10.0;

// Cache TTL. Long enough to kill the CTX-API-per-order load, short
// enough that quoted rates don't drift meaningfully against market.
const CACHE_TTL_MS = 30_000;

let _cache = /** @type {{ price: number, fetchedAt: number } | null} */ (null);

// Adversarial audit F5-xlm-price (2026-04-15): in-flight promise
// memoization to prevent a fetch stampede. When the 30s cache
// expires and N concurrent POST /v1/orders calls all hit
// getXlmUsdPrice() in the same event loop tick, without this guard
// all N enter the fetch branch, all N issue HTTP requests to CTX,
// and all N overwrite _cache at the end. Cards402 scale rarely
// hits CTX rate limits today, but:
//
//   - Each cache-miss burst consumes N quota units instead of 1.
//   - A POST /v1/orders DoS amplifies into a CTX-side DoS at N×
//     the request rate.
//   - Test mocks that count fetch invocations see non-deterministic
//     N depending on concurrency, making assertions flaky.
//
// The fix: track the outstanding fetch as a module-level promise.
// The first caller starts it; subsequent callers find a non-null
// `_inFlight` and await the same promise. The finally clears
// `_inFlight` after the fetch settles (success or failure), so
// the next batch starts fresh. Error path: all waiters share the
// same rejection, next caller after the rejection re-fetches.
let _inFlight = /** @type {Promise<number> | null} */ (null);

/**
 * Reset the cache. Exposed for tests so each case starts with a fresh
 * state — not meant for production callers.
 */
function _resetCache() {
  _cache = null;
  _inFlight = null;
}

/**
 * Fetch the current XLM/USD price from the CTX rates API.
 * Returns the ctx-average price as a number (e.g. 0.1550).
 * Throws if the API is unreachable, the ctx-average entry is missing,
 * or the returned price is outside the sanity bounds.
 */
async function getXlmUsdPrice() {
  // Cache hit — return immediately. Cache entries are tagged with
  // their fetch time so the age is queryable from tests and future
  // /status instrumentation.
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.price;
  }

  // F5: if another caller already started a fetch, wait for its
  // result instead of starting a duplicate.
  if (_inFlight) {
    return _inFlight;
  }

  // Start a fresh fetch, stash as in-flight so concurrent cache-
  // miss callers share it. The IIFE wraps the original fetch +
  // validate + cache logic and guarantees `_inFlight = null` via
  // finally, regardless of whether the fetch succeeds, times out,
  // returns a bad shape, or returns an out-of-bounds price.
  _inFlight = (async () => {
    try {
      const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`CTX rates API error: HTTP ${res.status}`);

      const rates = await res.json();
      if (!Array.isArray(rates)) {
        throw new Error(`CTX rates API returned non-array response (got ${typeof rates})`);
      }
      const avg = rates.find((r) => r && r.source === 'ctx-average');
      if (!avg) throw new Error('ctx-average entry missing from CTX rates response');

      const price = parseFloat(avg.price);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid XLM price from CTX: ${avg.price}`);
      }
      if (price < MIN_SANE_PRICE || price > MAX_SANE_PRICE) {
        // Don't cache a garbage value — force the next caller to re-fetch.
        bizEvent('xlm_price.out_of_bounds', { price, min: MIN_SANE_PRICE, max: MAX_SANE_PRICE });
        throw new Error(
          `XLM price ${price} is outside sanity bounds [${MIN_SANE_PRICE}, ${MAX_SANE_PRICE}] — ` +
            `refusing to quote. This usually means the CTX rates API returned bad data.`,
        );
      }

      _cache = { price, fetchedAt: Date.now() };
      return price;
    } finally {
      // Always clear the in-flight ref so the next batch can start
      // fresh. Cleared even on rejection — subsequent callers will
      // re-fetch rather than repeatedly seeing the stale rejection.
      _inFlight = null;
    }
  })();

  return _inFlight;
}

/**
 * Given a USD amount, return the equivalent XLM amount at the current ctx-average rate.
 * Result is rounded to 7 decimal places (stroop precision).
 *
 * Strict validation: throws on NaN / non-positive / non-finite inputs
 * rather than silently producing "NaN" strings that would then flow
 * downstream into the orders.expected_xlm_amount column.
 * @param {string|number} amountUsd
 */
async function usdToXlm(amountUsd) {
  const parsed = typeof amountUsd === 'number' ? amountUsd : parseFloat(String(amountUsd));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`usdToXlm: invalid amountUsd '${amountUsd}'`);
  }
  const price = await getXlmUsdPrice();
  const xlm = parsed / price;
  return xlm.toFixed(7);
}

module.exports = { getXlmUsdPrice, usdToXlm, _resetCache };
