// Helpers for agents using a raw Stellar keypair (S...) to pay the cards402
// receiver contract on Soroban. For OWS-wallet custody, see ./ows.ts.

import {
  Keypair,
  Networks,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  StrKey,
} from '@stellar/stellar-sdk';
import type { CardDetails, PaymentInstructions } from './client';
import {
  buildContractPaymentTx,
  submitSorobanTx,
  decimalToStroops,
  selectContractCall,
} from './soroban';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const HORIZON_TIMEOUT_MS = 15000;

function getHorizonUrl(networkPassphrase?: string): string {
  return networkPassphrase === Networks.TESTNET
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

function getServer(networkPassphrase?: string): Horizon.Server {
  return new Horizon.Server(getHorizonUrl(networkPassphrase));
}

function withTimeout<T>(promise: Promise<T>, ms = HORIZON_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Horizon request timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export interface WalletInfo {
  publicKey: string;
  secret: string; // Keep safe — never share
}

export function createWallet(): WalletInfo {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secret: keypair.secret() };
}

export async function getBalance(
  publicKey: string,
  networkPassphrase?: string,
): Promise<{ xlm: string; usdc: string }> {
  const server = getServer(networkPassphrase);
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

export async function addUsdcTrustline(
  secret: string,
  networkPassphrase = Networks.PUBLIC,
): Promise<string> {
  const server = getServer(networkPassphrase);
  const keypair = Keypair.fromSecret(secret);
  const account = await withTimeout(server.loadAccount(keypair.publicKey()));
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(300)
    .build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

// ── Contract payment ──────────────────────────────────────────────────────────

export interface PayOpts {
  walletSecret: string;
  payment: PaymentInstructions;
  paymentAsset?: 'usdc' | 'xlm';
  networkPassphrase?: string;
  sorobanRpcUrl?: string;
}

/**
 * Pay the cards402 receiver contract using a raw Stellar secret key.
 * Invokes pay_usdc or pay_xlm with the agent's G-address, the quoted amount
 * converted to 7-decimal stroops, and the order_id from the create-order
 * response. Returns the Soroban transaction hash.
 */
export async function payViaContract(opts: PayOpts): Promise<string> {
  const {
    walletSecret,
    payment,
    paymentAsset = 'usdc',
    networkPassphrase = Networks.PUBLIC,
    sorobanRpcUrl,
  } = opts;

  if (!StrKey.isValidContract(payment.contract_id)) {
    throw new Error(`Invalid contract_id in order response: ${payment.contract_id}`);
  }

  const keypair = Keypair.fromSecret(walletSecret);
  const { fn, amountDecimal } = selectContractCall(payment, paymentAsset);

  const { tx, server } = await buildContractPaymentTx({
    contractId: payment.contract_id,
    fn,
    fromPublicKey: keypair.publicKey(),
    amountStroops: decimalToStroops(amountDecimal),
    orderId: payment.order_id,
    networkPassphrase,
    rpcUrl: sorobanRpcUrl,
  });

  tx.sign(keypair);
  return submitSorobanTx(tx, server);
}

/**
 * Full purchase flow with a raw keypair: create order → invoke contract →
 * wait for card. Pass `resume: { orderId, payment }` to re-enter a partially
 * completed flow without creating a new order (S-9).
 */
export async function purchaseCard(opts: {
  apiKey: string;
  walletSecret: string;
  amountUsdc: string;
  paymentAsset?: 'usdc' | 'xlm';
  baseUrl?: string;
  networkPassphrase?: string;
  sorobanRpcUrl?: string;
  resume?: { orderId: string; payment: PaymentInstructions };
  waitForCardOpts?: { timeoutMs?: number; intervalMs?: number };
}): Promise<CardDetails & { order_id: string }> {
  const { Cards402Client } = await import('./client');
  const client = new Cards402Client({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const paymentAsset = opts.paymentAsset ?? 'usdc';

  let orderId: string;
  let payment: PaymentInstructions;

  if (opts.resume) {
    orderId = opts.resume.orderId;
    payment = opts.resume.payment;
    const status = await client.getOrder(orderId);
    if (status.phase !== 'awaiting_payment') {
      const card = await client.waitForCard(orderId, opts.waitForCardOpts);
      return { ...card, order_id: orderId };
    }
  } else {
    const order = await client.createOrder({
      amount_usdc: opts.amountUsdc,
      payment_asset: paymentAsset,
    });
    orderId = order.order_id;
    payment = order.payment;
  }

  await payViaContract({
    walletSecret: opts.walletSecret,
    payment,
    paymentAsset,
    networkPassphrase: opts.networkPassphrase,
    sorobanRpcUrl: opts.sorobanRpcUrl,
  });

  const card = await client.waitForCard(orderId, opts.waitForCardOpts);
  return { ...card, order_id: orderId };
}

// Back-compat aliases — the pre-V3 SDK exposed these names. Keep them around
// as deprecated exports so existing imports don't break on upgrade.

/** @deprecated Use `payViaContract` — this is the Soroban contract call, not a direct Stellar payment. */
export const payVCC = payViaContract;
