// Machine Payments Protocol (MPP) client helper.
//
// Entry point for agents that want to transact via MPP rather than the
// legacy /v1/orders flow. Semantics mirror any spec-compliant MPP
// client: GET the resource, read the 402 challenge, pay via the
// declared method, retry with an Authorization: Payment credential,
// collect the resource from the 200 (or poll the 202 Location).
//
// For cards402 specifically, the challenge's Stellar method maps onto
// the SDK's existing payViaContractOWS helper — so the OWS wallet,
// fee-retry logic, and on-chain confirmation all come for free.

import type { PaymentInstructions, CardDetails } from './client';
import { payViaContractOWS, type PayViaContractOwsDeps } from './ows';

export interface MppChargeOpts {
  /**
   * The full MPP resource URL. E.g. 'https://api.cards402.com/v1/cards/visa/10.00'.
   * This is the standards-compliant mode — works against any MPP server.
   */
  url?: string;

  /**
   * Convenience: build the URL from the cards402 base URL + USD amount.
   * Only one of `url` or `{baseUrl, amountUsdc}` is required.
   */
  baseUrl?: string;
  amountUsdc?: string;

  /** OWS wallet name to pay from. */
  walletName: string;
  passphrase?: string;
  vaultPath?: string;

  /** Force a specific asset. If unset, the first advertised method is used. */
  paymentAsset?: 'usdc' | 'xlm';

  /** Override the network passphrase (defaults to Stellar mainnet). */
  networkPassphrase?: string;
  /** Override the Soroban RPC URL. Defaults based on networkPassphrase. */
  sorobanRpcUrl?: string;

  /**
   * Maximum seconds to poll the 202 receipt URL before giving up. The
   * receipt polling kicks in only when the server returned 202 (card
   * fulfillment took longer than the server's sync wait). Default: 120s.
   */
  pollTimeoutMs?: number;

  /**
   * Injectable deps for testing. Mirrors PayViaContractOwsDeps so tests
   * don't need to touch real Soroban / wallet infrastructure.
   */
  _deps?: {
    fetch?: typeof fetch;
    payViaContractOWS?: typeof payViaContractOWS;
    payViaContractOwsDeps?: PayViaContractOwsDeps;
    sleep?: (ms: number) => Promise<void>;
  };
}

export interface MppChargeResult {
  /** The card details, once fulfillment completes. */
  card: CardDetails;
  /** Backend order id. Useful for cross-referencing with dashboards. */
  orderId: string;
  /** MPP challenge id that paid for this card. */
  challengeId: string;
  /** Stellar transaction hash that redeemed the challenge. */
  txHash: string;
  /** Receipt URL (may be useful for re-polling if the caller wants to persist it). */
  receiptUrl?: string;
  /** How the card was delivered — 'sync' on 200, 'async' on 202-then-poll. */
  delivery: 'sync' | 'async';
}

interface MppChallengeMethod {
  scheme: string;
  kind: string;
  contract_id: string;
  function: 'pay_usdc' | 'pay_xlm';
  asset: string;
  amount: string;
  amount_stroops?: string;
  memo_field?: string;
  memo_value?: string;
}

interface MppChallengeBody {
  error?: string;
  protocol: string;
  challenge_id: string;
  amount: { value: string; currency: string };
  expires_at: string;
  methods: MppChallengeMethod[];
  retry_url?: string;
}

const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

export async function mppCharge(opts: MppChargeOpts): Promise<MppChargeResult> {
  const url = resolveUrl(opts);
  const fetchImpl: typeof fetch = opts._deps?.fetch ?? fetch;
  const sleep = opts._deps?.sleep ?? defaultSleep;
  const payFn = opts._deps?.payViaContractOWS ?? payViaContractOWS;

  // ── Step 1: hit the resource, expect 402. ───────────────────────────
  const challengeRes = await fetchImpl(url, { method: 'GET' });
  if (challengeRes.status !== 402) {
    throw new Error(
      `mppCharge: expected 402 challenge from ${url}, got ${challengeRes.status}. ` +
        `Body: ${await safeText(challengeRes)}`,
    );
  }
  const challenge = (await challengeRes.json()) as MppChallengeBody;
  if (challenge.protocol !== 'mpp/1.0') {
    throw new Error(`mppCharge: unsupported MPP protocol ${challenge.protocol}`);
  }

  // ── Step 2: pick a method. ──────────────────────────────────────────
  const method = pickMethod(challenge.methods, opts.paymentAsset);
  if (!method) {
    throw new Error(`mppCharge: no supported payment method in challenge`);
  }
  if (method.scheme !== 'stellar' || method.kind !== 'soroban_contract') {
    throw new Error(
      `mppCharge: only soroban_contract stellar methods supported; got ${method.scheme}/${method.kind}`,
    );
  }

  // ── Step 3: pay via the Soroban receiver contract. ──────────────────
  //
  // Translate the MPP method into the PaymentInstructions shape that
  // payViaContractOWS already understands. Tiny adapter — keeps ows.ts
  // independent of MPP wire details.
  const paymentAsset: 'usdc' | 'xlm' = method.function === 'pay_xlm' ? 'xlm' : 'usdc';
  const paymentInstructions: PaymentInstructions = {
    type: 'soroban_contract',
    contract_id: method.contract_id,
    order_id: method.memo_value ?? challenge.challenge_id,
    usdc: {
      amount: paymentAsset === 'usdc' ? method.amount : challenge.amount.value,
      asset: paymentAsset === 'usdc' ? method.asset : '',
    },
    ...(paymentAsset === 'xlm' && { xlm: { amount: method.amount } }),
  };

  const txHash = await payFn(
    {
      walletName: opts.walletName,
      payment: paymentInstructions,
      paymentAsset,
      passphrase: opts.passphrase,
      vaultPath: opts.vaultPath,
      networkPassphrase: opts.networkPassphrase,
      sorobanRpcUrl: opts.sorobanRpcUrl,
    },
    opts._deps?.payViaContractOwsDeps ?? {},
  );

  // ── Step 4: retry the resource with Authorization: Payment. ─────────
  const authHeader = `Payment scheme="stellar", challenge="${challenge.challenge_id}", tx_hash="${txHash}"`;
  const retryRes = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: authHeader },
  });

  if (retryRes.status === 200) {
    const body = (await retryRes.json()) as {
      card: CardDetails;
      order_id: string;
      challenge_id: string;
      tx_hash: string;
    };
    return {
      card: body.card,
      orderId: body.order_id,
      challengeId: body.challenge_id,
      txHash: body.tx_hash,
      delivery: 'sync',
    };
  }

  if (retryRes.status === 202) {
    const body = (await retryRes.json()) as {
      receipt_id: string;
      order_id: string;
      poll_url: string;
    };
    const pollUrl = resolvePollUrl(url, body.poll_url);
    const final = await pollReceipt({
      url: pollUrl,
      fetchImpl,
      sleep,
      timeoutMs: opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    });
    return {
      card: final.card,
      orderId: body.order_id,
      challengeId: challenge.challenge_id,
      txHash,
      receiptUrl: pollUrl,
      delivery: 'async',
    };
  }

  throw new Error(
    `mppCharge: unexpected retry status ${retryRes.status}. Body: ${await safeText(retryRes)}`,
  );
}

async function pollReceipt({
  url,
  fetchImpl,
  sleep,
  timeoutMs,
}: {
  url: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<{ card: CardDetails }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchImpl(url, { method: 'GET' });
    if (res.status === 200) {
      const body = (await res.json()) as { card: CardDetails };
      return { card: body.card };
    }
    if (res.status === 202) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (res.status === 502) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`mppCharge: fulfillment failed — ${body.message ?? 'unknown reason'}`);
    }
    throw new Error(
      `mppCharge: unexpected receipt status ${res.status}. Body: ${await safeText(res)}`,
    );
  }
  throw new Error(`mppCharge: timed out polling receipt URL after ${timeoutMs}ms`);
}

function resolveUrl(opts: MppChargeOpts): string {
  if (opts.url) return opts.url;
  if (!opts.baseUrl || !opts.amountUsdc) {
    throw new Error(
      'mppCharge: either `url`, or both `baseUrl` and `amountUsdc`, must be provided',
    );
  }
  const base = opts.baseUrl.replace(/\/$/, '');
  return `${base}/cards/visa/${opts.amountUsdc}`;
}

function pickMethod(
  methods: MppChallengeMethod[],
  preferred?: 'usdc' | 'xlm',
): MppChallengeMethod | null {
  if (preferred === 'xlm') {
    return methods.find((m) => m.function === 'pay_xlm') ?? null;
  }
  if (preferred === 'usdc') {
    return methods.find((m) => m.function === 'pay_usdc') ?? null;
  }
  // No preference — prefer USDC (stable), fall back to XLM.
  return (
    methods.find((m) => m.function === 'pay_usdc') ??
    methods.find((m) => m.function === 'pay_xlm') ??
    null
  );
}

function resolvePollUrl(originalUrl: string, pollUrl: string): string {
  if (/^https?:\/\//.test(pollUrl)) return pollUrl;
  try {
    return new URL(pollUrl, originalUrl).toString();
  } catch {
    return pollUrl;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
