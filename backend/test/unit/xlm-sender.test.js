// Unit tests for xlm-sender.js — specifically the USDC→XLM probe and the
// two-op tx shape used for USDC-funded CTX fulfillment. Regression guards
// for the 2026-04-14 failures (op_over_source_max + CTX watcher ignoring
// path_payment_*).

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Patch the logger so bizEvent() in xlm-sender is a silent no-op during tests.
function patchCache(relPath, exports) {
  const abs = require.resolve(`../../src/${relPath}`);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}
patchCache('lib/logger', { event: () => {}, log: () => {} });

const { probeUsdcToXlmPath } = require('../../src/payments/xlm-sender');

// ── Fetch mock ────────────────────────────────────────────────────────────────

let fetchCalls = [];
let fetchImpl = null;
const realFetch = global.fetch;

function mockFetch(impl) {
  fetchImpl = impl;
}

global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  if (!fetchImpl) throw new Error(`unexpected fetch in test: ${url}`);
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('probeUsdcToXlmPath', () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchImpl = null;
  });
  afterEach(() => {
    fetchImpl = null;
  });

  it('hits the right Horizon endpoint with the destination amount', async () => {
    mockFetch(() => jsonResponse({ _embedded: { records: [] } }));
    await probeUsdcToXlmPath('187.8613425');
    assert.equal(fetchCalls.length, 1);
    const url = fetchCalls[0].url;
    assert.match(url, /\/paths\/strict-receive\?/);
    assert.match(url, /source_assets=USDC%3A/);
    assert.match(url, /destination_asset_type=native/);
    assert.match(url, /destination_amount=187\.8613425/);
  });

  it('returns ok:false when Horizon has no candidate paths', async () => {
    mockFetch(() => jsonResponse({ _embedded: { records: [] } }));
    const res = await probeUsdcToXlmPath('10');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no_path');
  });

  it('returns ok:false on transport error', async () => {
    mockFetch(() => {
      throw new Error('nope');
    });
    const res = await probeUsdcToXlmPath('10');
    assert.equal(res.ok, false);
    assert.match(res.reason, /probe_error/);
  });

  it('returns ok:false on non-2xx Horizon response', async () => {
    mockFetch(() => jsonResponse({}, 500));
    const res = await probeUsdcToXlmPath('10');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'http_500');
  });

  // The critical regression guard for the 2026-04-14 CTX-slippage bug:
  // probeUsdcToXlmPath must surface the concrete path array so that the
  // caller can pin it on the submission tx, not just the path length.
  it('surfaces the hydrated path[] from the cheapest candidate', async () => {
    const body = {
      _embedded: {
        records: [
          {
            source_amount: '29.2737583',
            path: [
              {
                asset_type: 'credit_alphanum12',
                asset_code: 'USTRY',
                asset_issuer: 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
              },
              {
                asset_type: 'credit_alphanum4',
                asset_code: 'LGSb',
                asset_issuer: 'GANE2MZDRECTZL3KXPO2SEQNOMPV3TXD6U6T2KQDOJKAWPWCKTF2LGST',
              },
            ],
          },
          // A deeper, more expensive candidate — should be ignored.
          { source_amount: '30.0', path: [] },
        ],
      },
    };
    mockFetch(() => jsonResponse(body));
    const res = await probeUsdcToXlmPath('187.8613425');
    assert.equal(res.ok, true);
    assert.equal(res.sourceAmount, '29.2737583');
    assert.equal(res.candidateCount, 2);
    assert.equal(res.pathLength, 2);
    assert.ok(Array.isArray(res.path), 'path must be returned as an array');
    assert.equal(res.path.length, 2);
    // stellar-sdk Asset objects — hydrated from Horizon's asset records.
    assert.equal(res.path[0].getCode(), 'USTRY');
    assert.equal(
      res.path[0].getIssuer(),
      'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC',
    );
    assert.equal(res.path[1].getCode(), 'LGSb');
    assert.equal(res.path[1].isNative?.() === true || res.path[1].getCode() === 'LGSb', true);
  });

  it('treats native assets in the path record as Asset.native()', async () => {
    const body = {
      _embedded: {
        records: [
          {
            source_amount: '10',
            path: [{ asset_type: 'native' }],
          },
        ],
      },
    };
    mockFetch(() => jsonResponse(body));
    const res = await probeUsdcToXlmPath('100');
    assert.equal(res.ok, true);
    assert.equal(res.path.length, 1);
    assert.equal(res.path[0].isNative(), true);
  });
});

// Restore global fetch when the suite ends.
process.on('exit', () => {
  global.fetch = realFetch;
});
