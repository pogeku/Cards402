// Regression tests for submitSorobanTx() error handling.
//
// 2026-04-14 bug: a submit whose tx was accepted by Soroban RPC (hash
// known) but then FAILED at apply time — or never made it into a
// ledger at all — was being treated as "finalization timed out, tx
// may still land" and thrown with `txHash` attached. purchaseCardOWS
// catches that txHash-attached error and falls through to waitForCard,
// leaving the CLI polling forever for a card that would never come.
//
// These tests pin the new contract:
//
//   - SUCCESS from getTransaction           → returns hash, no throw
//   - FAILED  from getTransaction           → throws WITHOUT txHash
//   - NOT_FOUND loop + Horizon 2xx success  → returns hash, no throw
//   - NOT_FOUND loop + Horizon 2xx failure  → throws WITHOUT txHash
//   - NOT_FOUND loop + Horizon 404          → throws WITHOUT txHash
//   - NOT_FOUND loop + Horizon unreachable  → throws WITH    txHash
//
// Only the last case should allow purchaseCardOWS to fall through to
// waitForCard. Every other case must propagate the error.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitSorobanTx } from '../soroban';
import type { Transaction } from '@stellar/stellar-sdk';

// Minimal mock Transaction — submitSorobanTx only passes it through to
// server.sendTransaction, which our mock doesn't care about.
const mockTx = {} as unknown as Transaction;

interface MockServer {
  sendTransaction: ReturnType<typeof vi.fn>;
  getTransaction: ReturnType<typeof vi.fn>;
}

function makeServer(getResponses: Array<{ status: string } | Error>): MockServer {
  const server: MockServer = {
    sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'HASH_ABC' }),
    getTransaction: vi.fn(),
  };
  let i = 0;
  server.getTransaction.mockImplementation(async () => {
    const r = getResponses[Math.min(i, getResponses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  });
  return server;
}

// Fake fetch for the Horizon-last-resort check. Each test installs the
// behaviour it wants.
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
});

beforeEach(() => {
  // Use fake timers so the 2s inter-poll sleep and the 120s deadline
  // don't make the tests slow. `shouldAdvanceTime` lets scheduled
  // timers fire automatically as the virtual clock moves — we just
  // need to nudge it forward with runAllTimersAsync once the promise
  // is in flight.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

// Catch the promise first, then advance timers until it settles.
// Returns either the resolved value or the error, never both.
async function runAndSettle<T>(
  promise: Promise<T>,
): Promise<{ value?: T; error?: Error & { txHash?: string } }> {
  let resolved = false;
  let rejected = false;
  let value: T | undefined;
  let error: (Error & { txHash?: string }) | undefined;
  // Attach handlers immediately so vitest doesn't count intermediate
  // states as unhandled rejections.
  const tracked = promise.then(
    (v) => {
      value = v;
      resolved = true;
    },
    (e) => {
      error = e as Error & { txHash?: string };
      rejected = true;
    },
  );
  // 130s of virtual time covers the 120s poll deadline comfortably.
  for (let i = 0; i < 70 && !resolved && !rejected; i++) {
    await vi.advanceTimersByTimeAsync(2000);
  }
  await tracked;
  return { value, error };
}

describe('submitSorobanTx — terminal states', () => {
  it('returns the hash on SUCCESS without any Horizon call', async () => {
    const server = makeServer([{ status: 'SUCCESS' }]);
    global.fetch = vi.fn().mockRejectedValue(new Error('should not be called'));
    const res = await runAndSettle(
      submitSorobanTx(mockTx, server as unknown as Parameters<typeof submitSorobanTx>[1]),
    );
    expect(res.value).toBe('HASH_ABC');
    expect(res.error).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws WITHOUT txHash on FAILED (tx applied on-chain but failed)', async () => {
    const server = makeServer([{ status: 'FAILED' }]);
    global.fetch = vi.fn();
    const res = await runAndSettle(
      submitSorobanTx(mockTx, server as unknown as Parameters<typeof submitSorobanTx>[1]),
    );
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('failed on-chain');
    // The critical regression guard: no txHash attached → purchaseCardOWS
    // will propagate the error instead of entering waitForCard.
    expect(res.error!.txHash).toBeUndefined();
  });
});

describe('submitSorobanTx — NOT_FOUND timeout then Horizon', () => {
  it('returns the hash when Horizon confirms the tx was successful', async () => {
    const server = makeServer([{ status: 'NOT_FOUND' }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ successful: true }),
    });
    const res = await runAndSettle(
      submitSorobanTx(mockTx, server as unknown as Parameters<typeof submitSorobanTx>[1]),
    );
    expect(res.value).toBe('HASH_ABC');
    expect(res.error).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });

  it('throws WITHOUT txHash when Horizon confirms the tx failed on-chain', async () => {
    const server = makeServer([{ status: 'NOT_FOUND' }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ successful: false }),
    });
    const res = await runAndSettle(
      submitSorobanTx(mockTx, server as unknown as Parameters<typeof submitSorobanTx>[1]),
    );
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('applied on-chain but failed');
    expect(res.error!.txHash).toBeUndefined();
  });

  it('throws WITH txHash AND dropped=true when Horizon 404s (provably dropped)', async () => {
    // Contract changed in the retry-loop work: the 404 case now
    // carries BOTH the tx hash AND a structured `dropped: true`
    // marker so payViaContractOWS's retry loop can distinguish
    // "safe to resubmit with same sequence" from "on-chain failure"
    // (same sequence would fail tx_bad_seq) and from "pending"
    // (same sequence might race). Without the marker, the retry
    // layer couldn't reliably decide whether to rebuild.
    //
    // purchaseCardOWS still treats dropped=true as 'unpaid' (does
    // NOT fall through to waitForCard) so the user doesn't hang on
    // a card that will never come — see ows.ts outer catch.
    const server = makeServer([{ status: 'NOT_FOUND' }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    const res = await runAndSettle(
      submitSorobanTx(mockTx, server as unknown as Parameters<typeof submitSorobanTx>[1]),
    );
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('never applied on the ledger');
    expect(res.error!.txHash).toBe('HASH_ABC');
    expect((res.error as Error & { dropped?: boolean }).dropped).toBe(true);
  });

  it('throws WITH txHash when Horizon is unreachable (network error)', async () => {
    const server = makeServer([{ status: 'NOT_FOUND' }]);
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await runAndSettle(
      submitSorobanTx(mockTx, server as unknown as Parameters<typeof submitSorobanTx>[1]),
    );
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain('Horizon is unreachable');
    // This is the ONLY case where we want the fall-through to waitForCard.
    expect(res.error!.txHash).toBe('HASH_ABC');
  });
});
