// OWS (Open Wallet Standard) wallet integration for cards402.
//
// Agents use an OWS wallet instead of a raw STELLAR_WALLET_SECRET:
//   - Keys are encrypted at rest in the OWS vault file
//   - BIP-44 derivation (m/44'/148'/0') for Stellar
//   - Same wallet works across EVM, Solana, Stellar (multi-chain portability)
//   - Supports passphrase protection and API key scoping
//
// Signing bridge: stellar-sdk computes the correct network-passphrase-prefixed
// hash; OWS ed25519-signs that hash; we attach the result as a DecoratedSignature.

import {
  createWallet as owsCreate,
  getWallet as owsGet,
  importWalletPrivateKey,
  signTransaction as owsSign,
  type WalletInfo,
} from '@ctx.com/stellar-ows-core';

import {
  Keypair,
  Networks,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';

import type { CardDetails, PaymentInstructions } from './client';
import { ResumableError, OrderFailedError, Cards402Error } from './errors';
import {
  buildContractPaymentTx,
  submitSorobanTx,
  decimalToStroops,
  selectContractCall,
} from './soroban';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HORIZON_URL = 'https://horizon.stellar.org';
const STELLAR_CHAIN = 'stellar';

function withTimeout<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Horizon request timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

/** Extract the Stellar G-address from an OWS WalletInfo. */
function getStellarAddress(wallet: WalletInfo): string {
  const account = wallet.accounts.find((a) => a.chainId.includes('stellar'));
  if (!account) throw new Error(`OWS wallet "${wallet.name}" has no Stellar account`);
  return account.address;
}

/**
 * Create an OWS wallet, or return the existing one if a wallet with this
 * name already exists in the vault. Idempotent by design — calling it
 * twice with the same name is safe and returns the same keys, so skill.md
 * flows and agent retries don't duplicate state.
 *
 * Wallets are stored encrypted at `~/.ows/wallets/<name>.vault` by
 * default. If the vault file is lost, the funds it controls become
 * unreachable — cards402 never sees private keys and can't recover
 * them. Agents running on ephemeral filesystems (Lambda, Cloud Run,
 * scratch containers) should pass a `vaultPath` pointing at a
 * persistent volume, or set the `OWS_VAULT_PATH` environment variable.
 */
export function createOWSWallet(
  name: string,
  passphrase?: string,
  vaultPath?: string,
): { walletId: string; publicKey: string } {
  // Fast path: existing wallet. Returns immediately if one is already in
  // the vault under this name.
  try {
    const existing = owsGet(name, vaultPath ?? null);
    return { walletId: existing.id, publicKey: getStellarAddress(existing) };
  } catch {
    /* not found — fall through to create */
  }
  const wallet = owsCreate(name, passphrase ?? null, undefined, vaultPath ?? null);
  return { walletId: wallet.id, publicKey: getStellarAddress(wallet) };
}

/**
 * Import an existing Stellar secret key (S...) into an OWS wallet.
 * Useful for migrating from a raw STELLAR_WALLET_SECRET to OWS custody.
 */
export function importStellarKey(
  name: string,
  stellarSecret: string,
  passphrase?: string,
  vaultPath?: string,
): { walletId: string; publicKey: string } {
  const keypair = Keypair.fromSecret(stellarSecret);
  const ed25519KeyHex = Buffer.from(keypair.rawSecretKey()).toString('hex');
  const wallet = importWalletPrivateKey(
    name,
    '', // secp256k1 key (EVM) — not used for Stellar
    passphrase ?? null,
    vaultPath ?? null,
    STELLAR_CHAIN,
    null, // secp256K1Key — not used
    ed25519KeyHex,
  );
  return { walletId: wallet.id, publicKey: getStellarAddress(wallet) };
}

/** Get the Stellar public key (G-address) for a named OWS wallet. */
export function getOWSPublicKey(walletName: string, vaultPath?: string): string {
  const wallet = owsGet(walletName, vaultPath ?? null);
  return getStellarAddress(wallet);
}

/** Check XLM and USDC balances for an OWS wallet. */
export async function getOWSBalance(
  walletName: string,
  vaultPath?: string,
): Promise<{ xlm: string; usdc: string }> {
  const publicKey = getOWSPublicKey(walletName, vaultPath);
  const server = new Horizon.Server(HORIZON_URL);
  const account = await withTimeout(server.loadAccount(publicKey));
  let xlm = '0',
    usdc = '0';
  for (const b of account.balances) {
    if (b.asset_type === 'native') xlm = b.balance;
    if (
      b.asset_type === 'credit_alphanum4' &&
      b.asset_code === 'USDC' &&
      b.asset_issuer === USDC_ISSUER
    )
      usdc = b.balance;
  }
  return { xlm, usdc };
}

// ── Onboarding helper ─────────────────────────────────────────────────────────

export interface OnboardAgentOpts {
  /** cards402 API key (cards402_…) */
  apiKey: string;
  /** Local name for the wallet in the OWS vault, e.g. 'my-agent' */
  walletName: string;
  /** Override the default https://api.cards402.com/v1 */
  baseUrl?: string;
  /** Optional passphrase for extra at-rest encryption */
  passphrase?: string;
  /** Override the default ~/.ows/wallets vault path — use a persistent
   *  volume if you're running on ephemeral storage (Lambda, Cloud Run,
   *  scratch containers). Lost vault = lost funds. */
  vaultPath?: string;
}

export interface OnboardAgentResult {
  publicKey: string;
  balance: { xlm: string; usdc: string };
}

/**
 * One-shot agent setup: reports `initializing` to cards402, creates or
 * fetches the OWS wallet, reports `awaiting_funding` with the wallet
 * address, and returns the public key + current balance. Idempotent —
 * safe to call on every agent startup.
 *
 * The backend broadcasts these transitions over the live SSE dashboard
 * feed, so operators see the agent moving through states in real time.
 */
export async function onboardAgent(opts: OnboardAgentOpts): Promise<OnboardAgentResult> {
  const { Cards402Client } = await import('./client');
  const client = new Cards402Client({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  // 1. Signal "spinning up" before we touch the filesystem. Best-effort:
  //    reportStatus swallows errors so a backend hiccup can't block setup.
  await client.reportStatus('initializing', { detail: 'creating wallet' });

  // 2. Create or fetch the wallet. Idempotent via createOWSWallet's
  //    getWallet-first path.
  const { publicKey } = createOWSWallet(opts.walletName, opts.passphrase, opts.vaultPath);

  // 3. Fetch balance. On a fresh wallet this hits Horizon and may 404
  //    if the account isn't activated yet (< 1 XLM on-chain). Swallow
  //    that case and return 0/0; the dashboard will show "Awaiting
  //    deposit" and the next getOWSBalance call will see the funds.
  let balance = { xlm: '0', usdc: '0' };
  try {
    balance = await getOWSBalance(opts.walletName, opts.vaultPath);
  } catch {
    /* unactivated account — normal on first run */
  }

  // 4. Report the wallet address so the dashboard can show it and
  //    start polling Horizon for the balance.
  await client.reportStatus('awaiting_funding', {
    wallet_public_key: publicKey,
    detail: `xlm=${balance.xlm} usdc=${balance.usdc}`,
  });

  return { publicKey, balance };
}

// ── Signing bridge ────────────────────────────────────────────────────────────

/**
 * Sign a stellar-sdk Transaction using an OWS wallet.
 *
 * stellar-sdk computes tx.hash() = sha256(network_passphrase_prefix || tx_xdr),
 * which is the exact 32-byte payload that must be ed25519-signed. We pass this
 * hash to OWS rather than the raw envelope so that network passphrase is handled
 * correctly regardless of OWS internals.
 */
interface SignableTx {
  hash(): Buffer;
  signatures: xdr.DecoratedSignature[];
}

function owsSignTx<T extends SignableTx>(
  tx: T,
  walletName: string,
  publicKey: string,
  passphrase?: string,
  vaultPath?: string,
): T {
  // The oceans404 Stellar fork's signTransaction expects the full transaction
  // envelope XDR, NOT just the hash. It internally:
  //   1. Parses the XDR envelope
  //   2. Builds the network-passphrase-prefixed signature payload
  //   3. Ed25519-signs the sha256 of that payload
  //   4. Returns the raw 64-byte signature
  const envelopeXdr = (tx as unknown as { toEnvelope(): { toXDR(fmt: string): string } })
    .toEnvelope()
    .toXDR('hex');
  const { signature: sigHex } = owsSign(
    walletName,
    STELLAR_CHAIN,
    envelopeXdr,
    passphrase ?? null,
    null,
    vaultPath ?? null,
  );

  const pubKeyBytes = StrKey.decodeEd25519PublicKey(publicKey);
  const hint = pubKeyBytes.slice(-4);
  tx.signatures.push(
    new xdr.DecoratedSignature({
      hint,
      signature: Buffer.from(sigHex, 'hex'),
    }),
  );
  return tx;
}

// ── Trustline ─────────────────────────────────────────────────────────────────

export interface TrustlineOpts {
  walletName: string;
  passphrase?: string;
  vaultPath?: string;
  networkPassphrase?: string;
}

/**
 * Add a USDC trustline to the OWS wallet's Stellar account.
 *
 * Idempotent: if the trustline already exists, returns `null` without
 * submitting a tx (Stellar accepts redundant `changeTrust` ops and
 * silently no-ops them, but charges the base fee each time — so
 * pre-checking saves ~0.00001 XLM per accidental re-run). Returns the
 * new tx hash when a trustline is actually opened.
 */
export async function addUsdcTrustlineOWS(opts: TrustlineOpts): Promise<string | null> {
  const { walletName, passphrase, vaultPath, networkPassphrase = Networks.PUBLIC } = opts;
  const publicKey = getOWSPublicKey(walletName, vaultPath);
  const horizonUrl =
    networkPassphrase === Networks.TESTNET ? 'https://horizon-testnet.stellar.org' : HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);
  const account = await withTimeout(server.loadAccount(publicKey));
  // Pre-check: already have a USDC trustline to the cards402-recognised
  // issuer? Return null without spending a fee.
  const balances = (account as unknown as { balances: Array<Record<string, unknown>> }).balances;
  const hasTrustline = balances.some(
    (b) =>
      b.asset_type === 'credit_alphanum4' &&
      b.asset_code === 'USDC' &&
      b.asset_issuer === USDC_ISSUER,
  );
  if (hasTrustline) return null;

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(300)
    .build();

  owsSignTx(tx, walletName, publicKey, passphrase, vaultPath);
  const result = await server.submitTransaction(tx);
  return (result as { hash: string }).hash;
}

// ── Soroban contract payment ──────────────────────────────────────────────────

export interface PayViaContractOwsOpts {
  walletName: string;
  payment: PaymentInstructions;
  paymentAsset?: 'usdc' | 'xlm';
  passphrase?: string;
  vaultPath?: string;
  networkPassphrase?: string;
  sorobanRpcUrl?: string;
}

/**
 * Pay the cards402 receiver contract using an OWS-custody wallet. Builds a
 * Soroban `pay_usdc` or `pay_xlm` invocation, signs the transaction hash via
 * OWS, and submits it to the Soroban RPC. Returns the transaction hash.
 */
export async function payViaContractOWS(opts: PayViaContractOwsOpts): Promise<string> {
  const {
    walletName,
    payment,
    paymentAsset = 'usdc',
    passphrase,
    vaultPath,
    networkPassphrase = Networks.PUBLIC,
    sorobanRpcUrl,
  } = opts;

  if (!StrKey.isValidContract(payment.contract_id)) {
    throw new Error(`Invalid contract_id in order response: ${payment.contract_id}`);
  }

  const publicKey = getOWSPublicKey(walletName, vaultPath);
  const { fn, amountDecimal } = selectContractCall(payment, paymentAsset);

  const { tx, server } = await buildContractPaymentTx({
    contractId: payment.contract_id,
    fn,
    fromPublicKey: publicKey,
    amountStroops: decimalToStroops(amountDecimal),
    orderId: payment.order_id,
    networkPassphrase,
    rpcUrl: sorobanRpcUrl,
  });

  owsSignTx(tx, walletName, publicKey, passphrase, vaultPath);
  return submitSorobanTx(tx, server);
}

// Back-compat aliases for the old exported names.

/** @deprecated Use `payViaContractOWS` — the old direct-Stellar path no longer matches the backend. */
export const payVCCOWS = payViaContractOWS;
/** @deprecated Kept for one migration cycle. */
export type PayVCCOwsOpts = PayViaContractOwsOpts;

// ── All-in-one ────────────────────────────────────────────────────────────────

export interface PurchaseCardOwsOpts {
  apiKey: string;
  walletName: string;
  amountUsdc: string;
  paymentAsset?: 'usdc' | 'xlm';
  passphrase?: string;
  vaultPath?: string;
  baseUrl?: string;
  networkPassphrase?: string;
  /**
   * Resume an existing order instead of creating a new one. Accepts either
   * a bare order id string (wait for the backend to finish an in-flight
   * payment) or an object with a fresh PaymentInstructions (resubmit).
   */
  resume?: string | { orderId: string; payment?: PaymentInstructions };
  /** Tune the card-ready poll. Default: { timeoutMs: 300_000, intervalMs: 3_000 }. */
  waitForCardOpts?: { timeoutMs?: number; intervalMs?: number };
}

/**
 * Full purchase flow using an OWS wallet: create order → pay the receiver
 * contract on Stellar → wait for card. Any failure after the order exists
 * is wrapped as a ResumableError so the caller can retry via `--resume`
 * without minting a new order.
 *
 * Soroban RPC backpressure is tolerated: if submitSorobanTx throws with a
 * txHash attached (deadline reached but tx may still land), we proceed to
 * waitForCard — the cards402 backend watcher is the source of truth and
 * will credit the order when the tx finalizes.
 */
export async function purchaseCardOWS(
  opts: PurchaseCardOwsOpts,
): Promise<CardDetails & { order_id: string }> {
  const { Cards402Client } = await import('./client');
  const client = new Cards402Client({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const paymentAsset = opts.paymentAsset ?? 'usdc';

  let orderId: string;
  let payment: PaymentInstructions | undefined;
  let skipPayment = false;

  if (opts.resume) {
    if (typeof opts.resume === 'string') {
      orderId = opts.resume;
    } else {
      orderId = opts.resume.orderId;
      payment = opts.resume.payment;
    }
    // Check where the order is — if the payment already landed (or is
    // landing), we can skip straight to waitForCard.
    const status = await client.getOrder(orderId);
    if (status.phase === 'ready' && status.card) {
      return { ...status.card, order_id: orderId };
    }
    if (
      status.phase === 'failed' ||
      status.phase === 'refunded' ||
      status.phase === 'rejected' ||
      status.phase === 'expired'
    ) {
      throw new OrderFailedError(orderId, status.error ?? status.phase, status.refund);
    }
    // awaiting_payment — a previous submit may still be in flight. If the
    //   caller didn't hand us a fresh PaymentInstructions, just wait; the
    //   backend will pick the tx up when it finalizes, or the order will
    //   expire cleanly. Resubmitting without the original payment object
    //   risks double-paying if the original lands after all.
    // processing / awaiting_approval — backend is working, just wait.
    if (status.phase !== 'awaiting_payment' || !payment) {
      skipPayment = true;
    }
  } else {
    const order = await client.createOrder({ amount_usdc: opts.amountUsdc });
    orderId = order.order_id;
    payment = order.payment;
  }

  if (!skipPayment) {
    if (!payment) {
      // Unreachable: the resume branch sets skipPayment when payment is
      // missing, and the create branch always sets payment.
      throw new ResumableError(
        orderId,
        'internal: payment instructions missing for an unpaid order',
        'unpaid',
      );
    }

    // USDC payments need a trustline on the wallet's Stellar account. If the
    // agent is paying in USDC and never added one, add it now so the
    // purchase doesn't silently fail on the payment step.
    if (paymentAsset === 'usdc') {
      try {
        const bal = await getOWSBalance(opts.walletName, opts.vaultPath);
        if (bal.usdc === '0') {
          const publicKey = getOWSPublicKey(opts.walletName, opts.vaultPath);
          const server = new Horizon.Server(HORIZON_URL);
          const account = await withTimeout(server.loadAccount(publicKey));
          const hasTrustline = account.balances.some(
            (b) =>
              b.asset_type === 'credit_alphanum4' &&
              b.asset_code === 'USDC' &&
              b.asset_issuer === USDC_ISSUER,
          );
          if (!hasTrustline) {
            await addUsdcTrustlineOWS({
              walletName: opts.walletName,
              passphrase: opts.passphrase,
              vaultPath: opts.vaultPath,
              networkPassphrase: opts.networkPassphrase,
            });
          }
        }
      } catch (err) {
        throw new ResumableError(
          orderId,
          `failed to ensure USDC trustline: ${err instanceof Error ? err.message : String(err)}. The wallet needs at least 2 XLM (1 for the account reserve, 1 for the trustline)`,
          'unpaid',
          undefined,
          err,
        );
      }
    }

    try {
      await payViaContractOWS({
        walletName: opts.walletName,
        payment,
        paymentAsset,
        passphrase: opts.passphrase,
        vaultPath: opts.vaultPath,
        networkPassphrase: opts.networkPassphrase,
      });
    } catch (err) {
      // submitSorobanTx attaches `txHash` to its error when the envelope
      // has been accepted onto the network but we gave up waiting for
      // finalization. In that case the cards402 backend watcher can
      // still credit the order — fall through to waitForCard instead of
      // failing the purchase.
      const txHash = (err as Error & { txHash?: string })?.txHash;
      if (!txHash) {
        throw new ResumableError(
          orderId,
          err instanceof Error ? err.message : String(err),
          'unpaid',
          undefined,
          err,
        );
      }
    }
  }

  try {
    const card = await client.waitForCard(orderId, opts.waitForCardOpts);
    return { ...card, order_id: orderId };
  } catch (err) {
    // OrderFailedError is terminal — propagate unchanged so the CLI
    // surfaces the real reason instead of a misleading resume hint.
    if (err instanceof OrderFailedError) throw err;
    // Auth / budget / validation errors from the client are also terminal.
    if (err instanceof Cards402Error && err.code !== 'wait_timeout') throw err;
    // Everything else (network blip, SSE disconnect, wait_timeout) — wrap
    // as resumable. The order is paid at this point; resuming will just
    // re-attach to the stream.
    throw new ResumableError(
      orderId,
      err instanceof Error ? err.message : String(err),
      'paid',
      undefined,
      err,
    );
  }
}
