// Unit tests for the XLM/USD price oracle.
//
// The module is normally stubbed out via require-cache in integration
// tests, so the real logic (cache TTL, sanity bounds, input validation,
// array-shape check) had no direct coverage. These tests cover the
// 2026-04-15 audit fixes.

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const XLM_PRICE_PATH = require.resolve('../../src/payments/xlm-price');

function freshModule() {
  delete require.cache[XLM_PRICE_PATH];
  return require('../../src/payments/xlm-price');
}

// ── Fetch stub ───────────────────────────────────────────────────────────────
const realFetch = global.fetch;
let fetchCount = 0;
let fetchImpl = null;

function mockFetch(impl) {
  fetchImpl = impl;
  fetchCount = 0;
}

global.fetch = async (url, opts) => {
  fetchCount += 1;
  if (!fetchImpl) throw new Error(`unexpected fetch: ${url}`);
  return fetchImpl(String(url), opts);
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function ctxAverage(price) {
  return [
    { source: 'ctx-average', price: String(price) },
    { source: 'kraken', price: '0.1600' },
  ];
}

describe('xlm-price — caching (F1)', () => {
  beforeEach(() => {
    fetchImpl = null;
    fetchCount = 0;
  });

  afterEach(() => {
    fetchImpl = null;
  });

  it('caches the price within the TTL — second call skips fetch', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse(ctxAverage('0.1234')));
    const p1 = await getXlmUsdPrice();
    const p2 = await getXlmUsdPrice();
    assert.equal(p1, 0.1234);
    assert.equal(p2, 0.1234);
    assert.equal(fetchCount, 1, 'second call should be served from cache');
  });

  it('does not cache an out-of-bounds price — next call re-fetches', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      // First response is bogus (too high), second is sane.
      return jsonResponse(ctxAverage(callCount === 1 ? '99999' : '0.1234'));
    });
    await assert.rejects(() => getXlmUsdPrice(), /outside sanity bounds/);
    // Second call should NOT hit a stale cached garbage price.
    const p = await getXlmUsdPrice();
    assert.equal(p, 0.1234);
    assert.equal(fetchCount, 2);
  });
});

describe('xlm-price — sanity bounds (F2)', () => {
  beforeEach(() => {
    fetchImpl = null;
    fetchCount = 0;
  });

  it('rejects a price above the 10.0 USD/XLM ceiling', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse(ctxAverage('15.0')));
    await assert.rejects(() => getXlmUsdPrice(), /outside sanity bounds/);
  });

  it('rejects a price below the 0.001 USD/XLM floor', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse(ctxAverage('0.0000001')));
    await assert.rejects(() => getXlmUsdPrice(), /outside sanity bounds/);
  });

  it('accepts a price at the high end of historical range', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse(ctxAverage('0.79')));
    const p = await getXlmUsdPrice();
    assert.equal(p, 0.79);
  });
});

describe('xlm-price — input validation (F3)', () => {
  beforeEach(() => {
    fetchImpl = null;
    fetchCount = 0;
  });

  it('rejects garbage amountUsd with a specific error (not "NaN" string)', async () => {
    const { usdToXlm, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse(ctxAverage('0.1234')));
    await assert.rejects(() => usdToXlm('not-a-number'), /invalid amountUsd/);
    await assert.rejects(() => usdToXlm(''), /invalid amountUsd/);
    await assert.rejects(() => usdToXlm('-5'), /invalid amountUsd/);
    await assert.rejects(() => usdToXlm('0'), /invalid amountUsd/);
    await assert.rejects(() => usdToXlm(null), /invalid amountUsd/);
  });

  it('round-trips a valid amountUsd', async () => {
    const { usdToXlm, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse(ctxAverage('0.1234')));
    const xlm = await usdToXlm('10.00');
    // 10 / 0.1234 = ~81.0372771
    assert.match(xlm, /^81\.03727/);
  });
});

describe('xlm-price — upstream shape check (F4)', () => {
  beforeEach(() => {
    fetchImpl = null;
    fetchCount = 0;
  });

  it('rejects a non-array response with a specific error', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse({ rates: [] }));
    await assert.rejects(() => getXlmUsdPrice(), /non-array response/);
  });

  it('rejects a missing ctx-average entry', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse([{ source: 'kraken', price: '0.16' }]));
    await assert.rejects(() => getXlmUsdPrice(), /ctx-average entry missing/);
  });

  it('rejects HTTP !ok from upstream', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(() => jsonResponse({}, 503));
    await assert.rejects(() => getXlmUsdPrice(), /HTTP 503/);
  });
});

// Restore real fetch on process exit so we don't leak the stub into
// other test files loaded by the same Node runner.
process.on('exit', () => {
  global.fetch = realFetch;
});
