// Soroban contract payment helpers — shared by raw-keypair (stellar.ts) and
// OWS-wallet (ows.ts) payment paths. The receiver contract's pay_usdc/pay_xlm
// functions take (from: Address, amount: i128, order_id: Bytes) and emit a
// payment event that the cards402 backend watcher indexes.

import {
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
  const account = await server.getAccount(opts.fromPublicKey);

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
  const POLL_DEADLINE_MS = 120_000;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const status = await server.getTransaction(send.hash);
      if (status.status === 'SUCCESS') return send.hash;
      if (status.status === 'FAILED') {
        throw new Error(`Soroban transaction ${send.hash} failed: ${status.status}`);
      }
      if (status.status !== 'NOT_FOUND') break;
    } catch (pollErr: unknown) {
      // "Bad union switch" = XDR version mismatch between SDK and RPC.
      // The TX was accepted by sendTransaction; confirm via Horizon instead.
      if (String((pollErr as Error)?.message || '').includes('Bad union switch')) {
        try {
          const horizonResp = await fetch(`https://horizon.stellar.org/transactions/${send.hash}`);
          if (horizonResp.ok) {
            const horizonData = (await horizonResp.json()) as { successful: boolean };
            if (horizonData.successful) return send.hash;
          }
        } catch {
          /* Horizon unreachable — keep polling Soroban RPC */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Last-resort Horizon check before giving up
  try {
    const horizonResp = await fetch(`https://horizon.stellar.org/transactions/${send.hash}`);
    if (horizonResp.ok) {
      const horizonData = (await horizonResp.json()) as { successful: boolean };
      if (horizonData.successful) return send.hash;
    }
  } catch {
    /* ignore */
  }

  // Throw with the hash so the caller can recover if the tx eventually
  // lands. purchaseCardOWS catches this and proceeds to waitForCard,
  // which subscribes to the cards402 backend SSE and gets credit from
  // the contract watcher even if Soroban RPC was slow to confirm.
  const err = new Error(
    `Soroban transaction ${send.hash} did not finalize within ${POLL_DEADLINE_MS / 1000}s`,
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
