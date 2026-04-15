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

// ── F5-xlm-price (2026-04-15): in-flight promise memoization ─────────
//
// When the 30s cache expires and N concurrent callers hit
// getXlmUsdPrice() in the same event loop tick, the pre-fix code
// issued N HTTP requests to CTX. Post-fix, the first caller kicks
// off a fetch and stashes it as _inFlight; subsequent callers
// await the same promise rather than issuing their own requests.

describe('xlm-price — F5 in-flight promise memoization', () => {
  beforeEach(() => {
    fetchImpl = null;
    fetchCount = 0;
  });

  afterEach(() => {
    fetchImpl = null;
  });

  it('5 concurrent callers on a fresh cache only trigger ONE fetch', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    // Slow fetch so we can fire multiple callers before the first
    // one has a chance to resolve. setImmediate delay is enough —
    // the event loop tick boundary between concurrent awaits lets
    // us observe the in-flight sharing.
    mockFetch(
      () =>
        new Promise((resolve) => setImmediate(() => resolve(jsonResponse(ctxAverage('0.1234'))))),
    );

    const results = await Promise.all([
      getXlmUsdPrice(),
      getXlmUsdPrice(),
      getXlmUsdPrice(),
      getXlmUsdPrice(),
      getXlmUsdPrice(),
    ]);

    // All five callers got the same price.
    for (const r of results) assert.equal(r, 0.1234);
    // Only ONE underlying HTTP request was issued.
    assert.equal(
      fetchCount,
      1,
      `expected 1 fetch, got ${fetchCount} — in-flight memoization is not active`,
    );
  });

  it('concurrent fetch rejection is shared across all waiters', async () => {
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();
    mockFetch(
      () => new Promise((_resolve, reject) => setImmediate(() => reject(new Error('CTX is down')))),
    );

    const results = await Promise.allSettled([
      getXlmUsdPrice(),
      getXlmUsdPrice(),
      getXlmUsdPrice(),
    ]);

    // All three callers see a rejection.
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.match(r.reason.message, /CTX is down/);
    }
    // Only one underlying fetch was made.
    assert.equal(fetchCount, 1);
  });

  it('next call after rejection starts a fresh fetch (no stuck rejection)', async () => {
    // Critical regression guard: the finally clause must clear
    // _inFlight even on rejection, so a transient CTX outage that
    // resolves 5 seconds later doesn't leave the oracle permanently
    // wedged on the old rejection.
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();

    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('transient'));
      return jsonResponse(ctxAverage('0.1550'));
    });

    await assert.rejects(() => getXlmUsdPrice(), /transient/);

    // Second call after the rejection must NOT see the cached
    // rejection — it must issue a fresh fetch and return the
    // recovered price.
    const price = await getXlmUsdPrice();
    assert.equal(price, 0.155);
    assert.equal(fetchCount, 2);
  });

  it('next call after success uses the cache (no superfluous fetch)', async () => {
    // Regression guard: the in-flight clear in finally must not
    // break the normal cache-hit path. After a successful fetch,
    // the cache is populated and the next call returns from cache.
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();

    mockFetch(() => jsonResponse(ctxAverage('0.1234')));
    await getXlmUsdPrice();
    await getXlmUsdPrice();
    await getXlmUsdPrice();
    assert.equal(fetchCount, 1, 'subsequent calls should be served from the cache');
  });

  it('concurrent burst on an out-of-bounds price shares the rejection', async () => {
    // Two paths collide here: the out-of-bounds rejection path (F2)
    // AND the in-flight memoization (F5). Fire concurrent callers
    // against a bogus-price mock and assert:
    //   (a) only ONE fetch is made (F5)
    //   (b) all waiters see the sanity-bound rejection (F2)
    //   (c) the cache is NOT poisoned (F2)
    //   (d) the next call after rejection starts fresh
    const { getXlmUsdPrice, _resetCache } = freshModule();
    _resetCache();

    let callCount = 0;
    mockFetch(() => {
      callCount += 1;
      // First fetch returns bogus; second is sane.
      return new Promise((resolve) =>
        setImmediate(() => resolve(jsonResponse(ctxAverage(callCount === 1 ? '99999' : '0.1234')))),
      );
    });

    const results = await Promise.allSettled([
      getXlmUsdPrice(),
      getXlmUsdPrice(),
      getXlmUsdPrice(),
    ]);
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.match(r.reason.message, /outside sanity bounds/);
    }
    assert.equal(fetchCount, 1, 'concurrent callers share the single fetch');

    // Recovery: next call fetches fresh and sees the sane price.
    const good = await getXlmUsdPrice();
    assert.equal(good, 0.1234);
    assert.equal(fetchCount, 2);
  });
});

// Restore real fetch on process exit so we don't leak the stub into
// other test files loaded by the same Node runner.
process.on('exit', () => {
  global.fetch = realFetch;
});
