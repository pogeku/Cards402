// @ts-check
// XLM/USD price from CTX rates API — ctx-average source, no buffer.

const RATES_URL = 'https://rates.ctx.com/rates?symbol=xlmusd';

/**
 * Fetch the current XLM/USD price from the CTX rates API.
 * Returns the ctx-average price as a number (e.g. 0.1550).
 * Throws if the API is unreachable or the ctx-average entry is missing.
 */
async function getXlmUsdPrice() {
  const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`CTX rates API error: HTTP ${res.status}`);

  const rates = await res.json();
  const avg = rates.find(r => r.source === 'ctx-average');
  if (!avg) throw new Error('ctx-average entry missing from CTX rates response');

  const price = parseFloat(avg.price);
  if (!isFinite(price) || price <= 0) throw new Error(`Invalid XLM price from CTX: ${avg.price}`);

  return price;
}

/**
 * Given a USD amount, return the equivalent XLM amount at the current ctx-average rate.
 * Result is rounded to 7 decimal places (stroop precision).
 */
async function usdToXlm(amountUsd) {
  const price = await getXlmUsdPrice();
  const xlm = parseFloat(amountUsd) / price;
  return xlm.toFixed(7);
}

module.exports = { getXlmUsdPrice, usdToXlm };
