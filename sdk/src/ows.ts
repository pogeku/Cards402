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
 * Wallets are stored encrypted at `~/.ows/vault/<name>.vault` by default.
 * Pass a custom `vaultPath` if you need the wallet somewhere else
 * (e.g. a mounted volume that survives container restarts).
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

/** Add a USDC trustline to the OWS wallet's Stellar account. */
export async function addUsdcTrustlineOWS(opts: TrustlineOpts): Promise<string> {
  const { walletName, passphrase, vaultPath, networkPassphrase = Networks.PUBLIC } = opts;
  const publicKey = getOWSPublicKey(walletName, vaultPath);
  const horizonUrl =
    networkPassphrase === Networks.TESTNET ? 'https://horizon-testnet.stellar.org' : HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);
  const account = await withTimeout(server.loadAccount(publicKey));
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
  /** Resume an existing order instead of creating a new one (idempotent retry — S-9). */
  resume?: { orderId: string; payment: PaymentInstructions };
  /** Tune the card-ready poll. Default: { timeoutMs: 300_000, intervalMs: 3_000 }. */
  waitForCardOpts?: { timeoutMs?: number; intervalMs?: number };
}

/**
 * Full purchase flow using an OWS wallet: create order → pay VCC on Stellar → wait for card.
 *
 * S-9 idempotency: pass `resume: { orderId, payment }` to skip re-creation on retry.
 * Payment is only sent if the order phase is still 'awaiting_payment'.
 */
export async function purchaseCardOWS(
  opts: PurchaseCardOwsOpts,
): Promise<CardDetails & { order_id: string }> {
  const { Cards402Client } = await import('./client');
  const client = new Cards402Client({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const paymentAsset = opts.paymentAsset ?? 'usdc';

  let orderId: string;
  let payment: PaymentInstructions;

  if (opts.resume) {
    orderId = opts.resume.orderId;
    payment = opts.resume.payment;
    // Skip payment if already received (idempotency — S-9)
    const status = await client.getOrder(orderId);
    if (status.phase !== 'awaiting_payment') {
      const card = await client.waitForCard(orderId, opts.waitForCardOpts);
      return { ...card, order_id: orderId };
    }
  } else {
    const order = await client.createOrder({ amount_usdc: opts.amountUsdc });
    orderId = order.order_id;
    payment = order.payment;
  }

  // USDC payments need a trustline on the wallet's Stellar account. If the
  // agent is paying in USDC and never added one, add it now so the
  // purchase doesn't silently fail on the payment step.
  if (paymentAsset === 'usdc') {
    try {
      const bal = await getOWSBalance(opts.walletName, opts.vaultPath);
      // getOWSBalance returns '0' when no USDC trustline exists, so we
      // also need to check the raw Horizon payload — any USDC entry
      // (even 0 balance) means the trustline is already present.
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
      throw new Error(
        `Failed to ensure USDC trustline for wallet "${opts.walletName}": ${
          err instanceof Error ? err.message : String(err)
        }. The wallet needs at least 2 XLM (1 for the account reserve, 1 for the trustline). Fund it with 'addUsdcTrustlineOWS' manually or retry once the wallet has enough XLM.`,
      );
    }
  }

  await payViaContractOWS({
    walletName: opts.walletName,
    payment,
    paymentAsset,
    passphrase: opts.passphrase,
    vaultPath: opts.vaultPath,
    networkPassphrase: opts.networkPassphrase,
  });

  const card = await client.waitForCard(orderId, opts.waitForCardOpts);
  return { ...card, order_id: orderId };
}
