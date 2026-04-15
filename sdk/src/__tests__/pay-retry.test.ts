// Unit tests for payViaContractOWS's retry-on-dropped-tx loop.
//
// The retry mechanism inside payViaContractOWS:
//
//   - On the first attempt, build + sign + submit as usual
//   - If the submit fails with `dropped: true` (provably never
//     landed on the ledger), capture the tx's sequence number
//   - Rebuild with preservedSequence = captured sequence so the
//     new tx has the SAME sequence as the prior one
//   - This guarantees mutual exclusion: at most one of the two
//     submits can ever land, so we can't double-pay even if the
//     original tx finally materialises during the retry delay
//
// Driven through the injectable `deps` parameter on
// payViaContractOWS so these tests don't touch a real OWS vault or
// real Soroban RPC. We assert what arguments each retry's build
// call receives.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Transaction } from '@stellar/stellar-sdk';

import { payViaContractOWS, type PayViaContractOwsDeps } from '../ows';
import type { PaymentInstructions } from '../client';

// ── Fixtures ────────────────────────────────────────────────────────────────

const FAKE_PUBLIC_KEY = 'GA3LSASMTRHWUKOUJ4VXQS6NT2S5GUHZO76MW2CZUQUWC7LSXQROAMGU';
const FAKE_CONTRACT = 'CB2JZVAJYFJZV4FMVTE2QCSF7EZKQ6SQB44JKON24WHZPRO43HRKUSA3';
const FAKE_ORDER_ID = 'test-order-abc';

function makePayment(): PaymentInstructions {
  return {
    type: 'soroban_contract',
    contract_id: FAKE_CONTRACT,
    order_id: FAKE_ORDER_ID,
    usdc: { amount: '0.25', asset: 'USDC:FAKEISSUER' },
    xlm: { amount: '1.5000000' },
  } as PaymentInstructions;
}

function makeDroppedError(txHash: string): Error & { txHash: string; dropped: true } {
  const err = new Error(
    `Soroban transaction ${txHash} was accepted by the RPC but never applied on the ledger within 120s — the network rejected it pre-apply.`,
  ) as Error & { txHash: string; dropped: true };
  err.txHash = txHash;
  err.dropped = true;
  return err;
}

// ── Harness ─────────────────────────────────────────────────────────────────
// Each test wires its own build/submit spies via the `deps` bundle.
// The fake build returns a tx whose `.sequence` equals either the
// preservedSequence (when set — the retry branch) or a default "100"
// (on the first attempt — the fresh-fetch branch). Real
// buildContractPaymentTx does exactly this: it either uses the
// preserved sequence or loads the current on-chain sequence.

function makeDeps(): {
  deps: PayViaContractOwsDeps;
  buildSpy: ReturnType<typeof vi.fn>;
  submitSpy: ReturnType<typeof vi.fn>;
  signSpy: ReturnType<typeof vi.fn>;
  pubKeySpy: ReturnType<typeof vi.fn>;
} {
  const buildSpy = vi.fn(
    async (opts: Parameters<NonNullable<PayViaContractOwsDeps['buildContractPaymentTx']>>[0]) => {
      const seq = opts.preservedSequence ?? '100';
      return {
        tx: { sequence: seq } as unknown as Transaction,
        server: {} as never,
      };
    },
  );
  const submitSpy = vi.fn<[Transaction, unknown], Promise<string>>();
  const signSpy = vi.fn();
  const pubKeySpy = vi.fn().mockReturnValue(FAKE_PUBLIC_KEY);
  return {
    deps: {
      buildContractPaymentTx: buildSpy as unknown as NonNullable<
        PayViaContractOwsDeps['buildContractPaymentTx']
      >,
      submitSorobanTx: submitSpy as unknown as NonNullable<
        PayViaContractOwsDeps['submitSorobanTx']
      >,
      owsSignTx: signSpy,
      getOWSPublicKey: pubKeySpy as unknown as NonNullable<
        PayViaContractOwsDeps['getOWSPublicKey']
      >,
    },
    buildSpy,
    submitSpy,
    signSpy,
    pubKeySpy,
  };
}

beforeEach(() => {
  // The retry loop has a 6s delay between attempts. Use fake timers
  // so tests don't wait the full 12s for 3 attempts.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('payViaContractOWS — retry on dropped Soroban tx', () => {
  it('retries with preserved sequence after one dropped attempt, then succeeds', async () => {
    const { deps, buildSpy, submitSpy } = makeDeps();
    // First submit throws dropped, second succeeds
    submitSpy
      .mockRejectedValueOnce(makeDroppedError('DROPPED_HASH'))
      .mockResolvedValueOnce('FAKE_SUCCESS_HASH');

    const promise = payViaContractOWS(
      { walletName: 'fake-wallet', payment: makePayment(), paymentAsset: 'xlm' },
      deps,
    );
    // Advance past the retry delay between attempts.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result).toBe('FAKE_SUCCESS_HASH');
    expect(buildSpy).toHaveBeenCalledTimes(2);
    // First build: no preservedSequence (fresh fetch from chain)
    expect(buildSpy.mock.calls[0][0].preservedSequence).toBeUndefined();
    // Second build: preservedSequence = first tx's sequence ('100')
    // Retry-and-mutual-exclusion: the retry tx has the same seq, so
    // if the original tx somehow lands during the retry delay, the
    // retry will fail with tx_bad_seq and we can't double-pay.
    expect(buildSpy.mock.calls[1][0].preservedSequence).toBe('100');
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  it('retries up to MAX_ATTEMPTS times then throws the last dropped error', async () => {
    const { deps, buildSpy, submitSpy } = makeDeps();
    // Every attempt drops
    submitSpy.mockRejectedValue(makeDroppedError('DROPPED_HASH'));

    const promise = payViaContractOWS(
      { walletName: 'fake-wallet', payment: makePayment(), paymentAsset: 'xlm' },
      deps,
    );
    // Ensure we advance past both retry delays (6s each, 2 delays = 12s)
    // plus headroom
    void vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).rejects.toThrow(/never applied on the ledger/);

    // 3 total attempts — matches PAY_VIA_CONTRACT_MAX_ATTEMPTS = 3
    expect(submitSpy).toHaveBeenCalledTimes(3);
    expect(buildSpy).toHaveBeenCalledTimes(3);
    expect(buildSpy.mock.calls[0][0].preservedSequence).toBeUndefined();
    expect(buildSpy.mock.calls[1][0].preservedSequence).toBe('100');
    expect(buildSpy.mock.calls[2][0].preservedSequence).toBe('100');
  });

  it('does NOT retry on an on-chain failure (sequence already consumed)', async () => {
    const { deps, buildSpy, submitSpy } = makeDeps();
    // Non-dropped error — retry with same seq would fail tx_bad_seq
    // because the on-chain-failed tx already consumed the sequence.
    submitSpy.mockRejectedValueOnce(new Error('Soroban transaction HASH failed on-chain'));

    await expect(
      payViaContractOWS(
        { walletName: 'fake-wallet', payment: makePayment(), paymentAsset: 'xlm' },
        deps,
      ),
    ).rejects.toThrow(/failed on-chain/);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a txHash-attached-but-not-dropped error', async () => {
    const { deps, submitSpy } = makeDeps();
    // Horizon-unreachable case: hash attached, dropped flag NOT set.
    // The tx may still be pending, so retry with same sequence
    // could race with a late-landing original.
    const err = new Error('Horizon unreachable') as Error & { txHash: string };
    err.txHash = 'MAYBE_LANDED_HASH';
    submitSpy.mockRejectedValueOnce(err);

    await expect(
      payViaContractOWS(
        { walletName: 'fake-wallet', payment: makePayment(), paymentAsset: 'xlm' },
        deps,
      ),
    ).rejects.toThrow(/Horizon unreachable/);

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the first attempt without any retry', async () => {
    const { deps, buildSpy, submitSpy } = makeDeps();
    submitSpy.mockResolvedValueOnce('FIRST_ATTEMPT_HASH');

    const result = await payViaContractOWS(
      { walletName: 'fake-wallet', payment: makePayment(), paymentAsset: 'xlm' },
      deps,
    );

    expect(result).toBe('FIRST_ATTEMPT_HASH');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('signs each attempt with the same wallet + public key', async () => {
    const { deps, submitSpy, signSpy } = makeDeps();
    submitSpy
      .mockRejectedValueOnce(makeDroppedError('DROPPED_HASH_1'))
      .mockResolvedValueOnce('FIRST_SUCCESS');

    const promise = payViaContractOWS(
      { walletName: 'fake-wallet', payment: makePayment(), paymentAsset: 'xlm' },
      deps,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(signSpy).toHaveBeenCalledTimes(2);
    // Every sign invocation uses the same wallet + pub key
    for (const call of signSpy.mock.calls) {
      expect(call[1]).toBe('fake-wallet');
      expect(call[2]).toBe(FAKE_PUBLIC_KEY);
    }
  });
});
