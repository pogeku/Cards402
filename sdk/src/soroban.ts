// Soroban contract payment helpers — shared by raw-keypair (stellar.ts) and
// OWS-wallet (ows.ts) payment paths. The receiver contract's pay_usdc/pay_xlm
// functions take (from: Address, amount: i128, order_id: Bytes) and emit a
// payment event that the cards402 backend watcher indexes.

import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

const MAINNET_RPC = 'https://mainnet.sorobanrpc.com';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';

export function getSorobanRpcUrl(networkPassphrase: string): string {
  return networkPassphrase === Networks.TESTNET ? TESTNET_RPC : MAINNET_RPC;
}

/**
 * Convert a decimal string like "10.00" or "1.2345678" to a 7-decimal i128
 * bigint (stroops / micro-USDC). Rejects inputs with >7 fractional digits.
 */
export function decimalToStroops(decimal: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`Invalid decimal amount: ${decimal}`);
  }
  const parts = decimal.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  if (frac.length > 7) {
    throw new Error(`Amount has more than 7 decimal places: ${decimal}`);
  }
  const padded = frac.padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(padded || '0');
}

export type PaymentFn = 'pay_usdc' | 'pay_xlm';

export interface BuildContractTxOpts {
  contractId: string;
  fn: PaymentFn;
  fromPublicKey: string;
  amountStroops: bigint;
  orderId: string;
  networkPassphrase: string;
  rpcUrl?: string;
  /**
   * Force the built tx to use this exact sequence number instead of
   * whatever Soroban RPC reports as the account's current sequence.
   *
   * Used by payViaContractOWS's retry loop to guarantee mutual
   * exclusion with a prior failed submit. If the original tx ends
   * up landing (e.g. it was accepted by the network despite the
   * client-side 120s deadline expiring), the retry — which shares
   * the same sequence — will fail with `tx_bad_seq` rather than
   * landing as a second payment. That gives us a free double-pay
   * safety property: at most one of the two attempts can ever
   * credit the order.
   *
   * Pass the sequence number that should appear in the built tx
   * (i.e. the post-bump value captured from a prior Transaction's
   * `.sequence` field). The builder internally converts that into
   * a pre-bump Account so the TransactionBuilder's
   * incrementSequenceNumber() call lands on exactly this value.
   */
  preservedSequence?: string;
}

/**
 * Build a Soroban transaction that invokes the receiver contract's pay_usdc
 * or pay_xlm function. Returns an unsigned, simulation-prepared Transaction
 * ready for the caller to sign (either via keypair or OWS) and submit.
 */
export async function buildContractPaymentTx(
  opts: BuildContractTxOpts,
): Promise<{ tx: Transaction; server: rpc.Server }> {
  const server = new rpc.Server(opts.rpcUrl ?? getSorobanRpcUrl(opts.networkPassphrase));
  // When preservedSequence is set, build the Account manually from
  // the pre-bump value (N-1) so TransactionBuilder's implicit
  // incrementSequenceNumber() call lands exactly on the requested N.
  // Otherwise, load the current on-chain state.
  const account = opts.preservedSequence
    ? new Account(opts.fromPublicKey, (BigInt(opts.preservedSequence) - 1n).toString())
    : await server.getAccount(opts.fromPublicKey);

  const contract = new Contract(opts.contractId);
  const orderIdBytes = Buffer.from(opts.orderId, 'utf-8');
  const op = contract.call(
    opts.fn,
    new Address(opts.fromPublicKey).toScVal(),
    nativeToScVal(opts.amountStroops, { type: 'i128' }),
    nativeToScVal(orderIdBytes, { type: 'bytes' }),
  );

  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Soroban simulation failed: ${sim.error}`);
  }

  const prepared = rpc.assembleTransaction(raw, sim).build();
  return { tx: prepared, server };
}

/**
 * Submit a signed Soroban transaction and poll until it reaches a terminal
 * status. Returns the transaction hash on success.
 *
 * Important: a successful return only guarantees the tx has been accepted
 * onto the ledger. The cards402 backend's contract watcher is the source
 * of truth for "the order has been credited" — the SDK's purchaseCardOWS
 * always follows up with waitForCard against the order id, so even if
 * this function gives up before finalization, the watcher still has a
 * chance to credit the order if the tx eventually lands.
 */
export async function submitSorobanTx(tx: Transaction, server: rpc.Server): Promise<string> {
  // sendTransaction is idempotent for the same envelope. Three cases we
  // retry explicitly:
  //   - TRY_AGAIN_LATER: RPC is congested, re-send after a short wait
  //   - thrown network error (fetch/DNS/TCP): the request never reached
  //     the RPC, safe to retry
  //   - DUPLICATE is treated as "already in flight" — fall through to
  //     the polling loop below instead of looping forever
  // Up to 5 total attempts with 1.5s spacing covers typical RPC drops.
  const MAX_SEND_ATTEMPTS = 5;
  let send: Awaited<ReturnType<typeof server.sendTransaction>> | undefined;
  let sendErr: unknown;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      send = await server.sendTransaction(tx);
      if (send.status === 'TRY_AGAIN_LATER') {
        if (attempt < MAX_SEND_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw new Error(
          `Soroban network congested — sendTransaction returned TRY_AGAIN_LATER after ${MAX_SEND_ATTEMPTS} attempts. Retry the purchase in a minute.`,
        );
      }
      if (send.status === 'ERROR') {
        throw new Error(
          `Soroban sendTransaction error: ${JSON.stringify(send.errorResult ?? send)}`,
        );
      }
      // PENDING or DUPLICATE — envelope is now known to the network. Break
      // out of the retry loop and poll for finalization.
      break;
    } catch (err) {
      sendErr = err;
      // If the thrown error is structured (TRY_AGAIN_LATER, ERROR) let it
      // propagate directly. Otherwise assume it was a transient network
      // failure and retry.
      if (
        err instanceof Error &&
        (err.message.startsWith('Soroban network congested') ||
          err.message.startsWith('Soroban sendTransaction error'))
      ) {
        throw err;
      }
      if (attempt >= MAX_SEND_ATTEMPTS - 1) {
        throw new Error(
          `Soroban sendTransaction failed after ${MAX_SEND_ATTEMPTS} attempts: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!send) {
    throw new Error(
      `Soroban sendTransaction produced no result: ${(sendErr as Error)?.message ?? 'unknown error'}`,
    );
  }

  // Poll for finalization. 120s deadline (was 60s) so we don't bail on
  // mainnet RPC under modest backpressure. Each poll is cheap; the cost
  // of a longer wait is much less than the cost of a stranded order.
  // Some stellar-sdk versions can't parse newer Soroban RPC response XDR
  // ("Bad union switch: 4"); when that happens, fall back to Horizon.
  //
  // Error-handling contract — changed 2026-04-14 after we shipped a
  // stranded-order bug where FAILED statuses from getTransaction were
  // silently caught by the inner try/catch and the loop kept polling
  // until the deadline, at which point a txHash-attached error was
  // thrown and purchaseCardOWS fell through to waitForCard on a tx
  // that had actually failed on-chain. The new rules are:
  //
  //   - Any throw whose message starts with "Soroban transaction " is
  //     one of OUR OWN terminal throws; the catch re-raises it out of
  //     the while loop unchanged.
  //   - A `txHash` is only attached to the final timeout error when we
  //     genuinely believe the tx MAY still land on the ledger later
  //     (Horizon unreachable). In every other terminal state — tx
  //     applied and failed, or Horizon confirms the tx never made a
  //     ledger — we throw a plain Error, which purchaseCardOWS will
  //     propagate to the caller instead of entering waitForCard.
  const POLL_DEADLINE_MS = 120_000;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const status = await server.getTransaction(send.hash);
      if (status.status === 'SUCCESS') return send.hash;
      if (status.status === 'FAILED') {
        throw new Error(`Soroban transaction ${send.hash} failed on-chain`);
      }
      // NOT_FOUND (or any transient non-terminal status): keep polling.
    } catch (pollErr: unknown) {
      // Re-raise our own terminal throws so they escape the loop.
      if (
        pollErr instanceof Error &&
        pollErr.message.startsWith(`Soroban transaction ${send.hash}`)
      ) {
        throw pollErr;
      }
      // "Bad union switch" = XDR version mismatch between SDK and RPC.
      // The TX was accepted by sendTransaction; confirm via Horizon instead.
      if (String((pollErr as Error)?.message || '').includes('Bad union switch')) {
        try {
          const horizonResp = await fetch(`https://horizon.stellar.org/transactions/${send.hash}`);
          if (horizonResp.ok) {
            const horizonData = (await horizonResp.json()) as { successful: boolean };
            if (horizonData.successful) return send.hash;
            // Horizon can see it and it failed — terminal, no recovery.
            throw new Error(`Soroban transaction ${send.hash} failed on-chain (Horizon)`);
          }
        } catch (horizonErr) {
          // Re-raise our own terminal Horizon throws
          if (
            horizonErr instanceof Error &&
            horizonErr.message.startsWith(`Soroban transaction ${send.hash}`)
          ) {
            throw horizonErr;
          }
          /* Horizon unreachable — keep polling Soroban RPC */
        }
      }
      // Any other poll-layer error: treat as transient, keep polling.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Deadline reached without a terminal status. Before giving up, ask
  // Horizon what actually happened to the tx — it's the authoritative
  // record of what hit a ledger, independent of Soroban RPC's state.
  try {
    const horizonResp = await fetch(`https://horizon.stellar.org/transactions/${send.hash}`);
    if (horizonResp.ok) {
      const horizonData = (await horizonResp.json()) as { successful: boolean };
      if (horizonData.successful) return send.hash;
      // Tx landed and failed. No recovery path — throw without txHash
      // so the caller propagates the error instead of waiting on a card
      // that will never come.
      throw new Error(
        `Soroban transaction ${send.hash} applied on-chain but failed — no card will be credited. Retry the purchase.`,
      );
    }
    if (horizonResp.status === 404) {
      // Tx was accepted by Soroban RPC (we have a hash) but it never
      // made it into a ledger on Horizon. This is the "network rejected
      // at apply time" case — e.g., source account sequence drifted,
      // host function errored before any effects landed. It is NOT
      // going to "eventually land".
      //
      // Attach both txHash and a structured `dropped: true` marker.
      // payViaContractOWS's retry loop uses the marker to decide whether
      // to resubmit with the same sequence (guaranteeing mutual
      // exclusion). Without the marker, the retry layer can't
      // distinguish this case from "on-chain failure" (where retrying
      // would be incorrect because the sequence was consumed by the
      // failed tx).
      const droppedErr = new Error(
        `Soroban transaction ${send.hash} was accepted by the RPC but never applied on the ledger within ${POLL_DEADLINE_MS / 1000}s — the network rejected it pre-apply. Retry the purchase.`,
      ) as Error & { txHash: string; dropped: true };
      droppedErr.txHash = send.hash;
      droppedErr.dropped = true;
      throw droppedErr;
    }
  } catch (horizonErr) {
    // Re-raise our own terminal Horizon throws; swallow network errors.
    if (
      horizonErr instanceof Error &&
      horizonErr.message.startsWith(`Soroban transaction ${send.hash}`)
    ) {
      throw horizonErr;
    }
    /* Horizon itself is unreachable — fall through to the timeout
       error below, where we attach txHash as a last-resort safety net.
       The watcher may still credit the order if the tx eventually
       lands and Horizon comes back up. */
  }

  // Soroban RPC never saw a terminal state AND Horizon is unreachable
  // (or the response was neither 2xx nor 404). We genuinely don't know
  // whether the tx landed, so attach txHash and let purchaseCardOWS
  // give the cards402 backend watcher a chance to credit the order.
  const err = new Error(
    `Soroban transaction ${send.hash} did not finalize within ${POLL_DEADLINE_MS / 1000}s and Horizon is unreachable`,
  );
  (err as Error & { txHash?: string }).txHash = send.hash;
  throw err;
}

/**
 * Decide which contract function + asset amount to use based on the
 * PaymentInstructions returned from POST /v1/orders.
 */
export function selectContractCall(
  payment: { usdc: { amount: string }; xlm?: { amount: string } },
  paymentAsset: 'usdc' | 'xlm',
): { fn: PaymentFn; amountDecimal: string } {
  if (paymentAsset === 'xlm') {
    if (!payment.xlm?.amount) {
      throw new Error('Order response does not include an XLM quote');
    }
    return { fn: 'pay_xlm', amountDecimal: payment.xlm.amount };
  }
  return { fn: 'pay_usdc', amountDecimal: payment.usdc.amount };
}

// Re-export xdr so callers in sibling modules can construct DecoratedSignature
// without importing the whole stellar-sdk surface.
export { xdr };
