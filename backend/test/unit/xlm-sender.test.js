// Unit tests for xlm-sender.js — specifically the USDC→XLM probe, the
// two-op tx shape used for USDC-funded CTX fulfillment, and the
// submitWithRetry network-error resolver (audit F1-xlm-sender).
// Regression guards for:
//   - 2026-04-14 failures (op_over_source_max + CTX watcher ignoring
//     path_payment_*)
//   - 2026-04-15 audit F1 (network-error uncertainty → double-spend risk)
//   - 2026-04-15 audit F2 (missing source_amount bypasses early-abort)

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

// ── F2: probeUsdcToXlmPath source_amount validation ──────────────────────

describe('probeUsdcToXlmPath — F2 source_amount validation', () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchImpl = null;
  });

  it('rejects records with a missing source_amount field', async () => {
    // Pre-F2: `Number(undefined)` → NaN, `NaN < destMin` → false, early
    // abort silently passes, submit proceeds against an unpriced path.
    // Post-F2: probe fails with reason='invalid_source_amount'.
    mockFetch(() =>
      jsonResponse({
        _embedded: { records: [{ path: [] /* source_amount missing */ }] },
      }),
    );
    const res = await probeUsdcToXlmPath('10');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid_source_amount');
  });

  it('rejects records with a zero source_amount', async () => {
    mockFetch(() =>
      jsonResponse({
        _embedded: { records: [{ source_amount: '0', path: [] }] },
      }),
    );
    const res = await probeUsdcToXlmPath('10');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid_source_amount');
  });

  it('rejects records with a non-numeric source_amount', async () => {
    mockFetch(() =>
      jsonResponse({
        _embedded: { records: [{ source_amount: 'free', path: [] }] },
      }),
    );
    const res = await probeUsdcToXlmPath('10');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid_source_amount');
  });
});

// ── F1: submitWithRetry network-error resolver ──────────────────────────
//
// These tests mock the module-local `server` binding inside xlm-sender.js
// by loading the module and monkey-patching `Horizon.Server.prototype`.
// We drive submitWithRetry directly via the exported handle and assert
// the outcome + stellarStatus marker on the thrown error.

describe('submitWithRetry — F1 network-error resolution', () => {
  const { submitWithRetry } = require('../../src/payments/xlm-sender');
  const {
    Horizon,
    Keypair,
    Account,
    TransactionBuilder,
    Networks,
    Operation,
    Asset,
  } = require('@stellar/stellar-sdk');

  // Real Horizon.Server.prototype methods — restored after each test.
  const realLoadAccount = Horizon.Server.prototype.loadAccount;
  const realSubmit = Horizon.Server.prototype.submitTransaction;
  const realTransactions = Horizon.Server.prototype.transactions;

  afterEach(() => {
    Horizon.Server.prototype.loadAccount = realLoadAccount;
    Horizon.Server.prototype.submitTransaction = realSubmit;
    Horizon.Server.prototype.transactions = realTransactions;
  });

  // Fresh random keypair per suite — tests never touch the real network,
  // but buildTx closures still need a valid keypair to produce a signed
  // transaction envelope. Random is fine because nothing in the tests
  // asserts the specific public key.
  const testKeypair = Keypair.random();
  const testAccount = new Account(testKeypair.publicKey(), '100');

  function makeBuildTx() {
    return (account) =>
      new TransactionBuilder(account, {
        fee: '100000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            asset: Asset.native(),
            amount: '1.0000000',
          }),
        )
        .setTimeout(60)
        .build();
  }

  it('returns the hash on a successful submit', async () => {
    Horizon.Server.prototype.loadAccount = async () => new Account(testKeypair.publicKey(), '100');
    Horizon.Server.prototype.submitTransaction = async () => ({ hash: 'HAPPY_HASH' });

    const hash = await submitWithRetry(makeBuildTx(), testKeypair);
    assert.equal(hash, 'HAPPY_HASH');
  });

  it('retries on tx_bad_seq and succeeds on the second attempt', async () => {
    let loadCount = 0;
    Horizon.Server.prototype.loadAccount = async () => {
      loadCount += 1;
      return new Account(testKeypair.publicKey(), String(100 + loadCount));
    };
    let submitCount = 0;
    Horizon.Server.prototype.submitTransaction = async () => {
      submitCount += 1;
      if (submitCount === 1) {
        const err = /** @type {any} */ (new Error('bad seq'));
        err.response = { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
        throw err;
      }
      return { hash: 'RETRY_HASH' };
    };

    const hash = await submitWithRetry(makeBuildTx(), testKeypair);
    assert.equal(hash, 'RETRY_HASH');
    assert.equal(submitCount, 2);
    assert.equal(loadCount, 2, 'loadAccount must re-run on tx_bad_seq');
  });

  it('propagates structured non-tx_bad_seq errors without resolver lookup', async () => {
    Horizon.Server.prototype.loadAccount = async () => testAccount;
    Horizon.Server.prototype.submitTransaction = async () => {
      const err = /** @type {any} */ (new Error('op failed'));
      err.response = {
        data: {
          extras: { result_codes: { transaction: 'tx_failed', operations: ['op_under_dest_min'] } },
        },
      };
      throw err;
    };
    // Resolver should never be called — but if it is, make it throw loudly.
    Horizon.Server.prototype.transactions = () => {
      throw new Error('resolver must not be called for structured errors');
    };

    await assert.rejects(submitWithRetry(makeBuildTx(), testKeypair), /op failed/);
  });

  it('network error + Horizon lookup succeeds → returns the hash', async () => {
    // The critical safety property: a lost-response network error where
    // the tx actually landed MUST resolve to success, not a retry.
    Horizon.Server.prototype.loadAccount = async () => testAccount;
    Horizon.Server.prototype.submitTransaction = async () => {
      throw new Error('ECONNRESET'); // no result_codes → network path
    };
    Horizon.Server.prototype.transactions = () => ({
      transaction: (_hash) => ({
        call: async () => ({ successful: true }),
      }),
    });

    const hash = await submitWithRetry(makeBuildTx(), testKeypair);
    // Returned hash is the envelope hash we precomputed — not literal
    // because the signature depends on keypair+seq, but we can assert
    // it's a 64-char hex string.
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('network error + Horizon 404 → throws with stellarStatus=not_landed', async () => {
    Horizon.Server.prototype.loadAccount = async () => testAccount;
    Horizon.Server.prototype.submitTransaction = async () => {
      throw new Error('fetch timeout');
    };
    Horizon.Server.prototype.transactions = () => ({
      transaction: (_hash) => ({
        call: async () => {
          const err = /** @type {any} */ (new Error('Not found'));
          err.response = { status: 404 };
          throw err;
        },
      }),
    });

    let caught;
    try {
      await submitWithRetry(makeBuildTx(), testKeypair);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected throw');
    assert.equal(caught.stellarStatus, 'not_landed');
    assert.match(caught.message, /safe to retry/);
    assert.match(caught.txHash, /^[0-9a-f]{64}$/);
  });

  it('network error + Horizon lookup itself fails → throws with stellarStatus=unknown', async () => {
    // The most cautious case: we don't know if the tx landed AND we
    // can't even confirm Horizon is healthy. Caller must NOT retry.
    Horizon.Server.prototype.loadAccount = async () => testAccount;
    Horizon.Server.prototype.submitTransaction = async () => {
      throw new Error('socket hang up');
    };
    Horizon.Server.prototype.transactions = () => ({
      transaction: (_hash) => ({
        call: async () => {
          const err = /** @type {any} */ (new Error('Bad gateway'));
          err.response = { status: 502 };
          throw err;
        },
      }),
    });

    let caught;
    try {
      await submitWithRetry(makeBuildTx(), testKeypair);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.stellarStatus, 'unknown');
    assert.match(caught.message, /Horizon lookup also failed/);
  });

  it('network error + Horizon found-but-failed → stellarStatus=applied_failed', async () => {
    // The tx landed on chain BUT tx_failed at apply time. Caller must
    // NOT treat it as a safe retry — the sequence has been consumed.
    Horizon.Server.prototype.loadAccount = async () => testAccount;
    Horizon.Server.prototype.submitTransaction = async () => {
      throw new Error('network flake');
    };
    Horizon.Server.prototype.transactions = () => ({
      transaction: (_hash) => ({
        call: async () => ({
          successful: false,
          result_codes: { transaction: 'tx_failed' },
        }),
      }),
    });

    let caught;
    try {
      await submitWithRetry(makeBuildTx(), testKeypair);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.stellarStatus, 'applied_failed');
    assert.match(caught.message, /applied on-chain but failed/);
  });
});

// Restore global fetch when the suite ends.
process.on('exit', () => {
  global.fetch = realFetch;
});
