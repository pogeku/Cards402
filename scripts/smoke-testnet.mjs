#!/usr/bin/env node
/**
 * Testnet smoke test for the cards402 SDK + backend + Soroban contract.
 *
 * Does one real round-trip against a running backend and a deployed testnet
 * receiver contract:
 *
 *   1. POST /v1/orders to create a pending order
 *   2. Use the SDK's payViaContract to invoke pay_usdc on the contract
 *   3. Poll GET /v1/orders/:id until phase is terminal
 *   4. Print what happened and exit with 0 on success, non-zero on failure
 *
 * This is intentionally a real end-to-end call — it catches things the
 * in-process integration test cannot (network passphrase mismatches, stellar-
 * sdk version drift, RPC URL issues, contract ABI drift, real simulateTx
 * behavior). Run it before any production release.
 *
 * Usage:
 *   node scripts/smoke-testnet.mjs
 *
 * Required env vars (see scripts/smoke-testnet.env.example):
 *   CARDS402_API_BASE       — e.g. https://staging.cards402.com/v1
 *   CARDS402_API_KEY        — a test API key issued against the target backend
 *   STELLAR_WALLET_SECRET   — a testnet Stellar secret (S...) pre-funded with
 *                             testnet USDC + some XLM for fees
 *   STELLAR_NETWORK         — 'testnet' (default) or 'mainnet'
 *   SOROBAN_RPC_URL         — optional; defaults to the public testnet RPC
 *
 * Optional:
 *   AMOUNT_USDC             — default '0.10'
 *   PAYMENT_ASSET           — 'usdc' (default) or 'xlm'
 *   TIMEOUT_MS              — how long to poll for phase=ready; default 300000
 *
 * Exit codes:
 *   0 = phase landed at 'ready' and card details were returned
 *   1 = phase landed at 'failed' / 'refunded' / 'rejected' / 'expired'
 *   2 = timed out waiting for a terminal phase
 *   3 = unrecoverable error (network, config, SDK, contract call)
 */

import { Cards402Client, payViaContract } from '../sdk/dist/index.js';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`✖ ${name} is required. See scripts/smoke-testnet.env.example.`);
    process.exit(3);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}

const CARDS402_API_BASE = required('CARDS402_API_BASE');
const CARDS402_API_KEY = required('CARDS402_API_KEY');
const STELLAR_WALLET_SECRET = required('STELLAR_WALLET_SECRET');
const STELLAR_NETWORK = optional('STELLAR_NETWORK', 'testnet');
const SOROBAN_RPC_URL = optional('SOROBAN_RPC_URL', null);
const AMOUNT_USDC = optional('AMOUNT_USDC', '0.10');
const PAYMENT_ASSET = optional('PAYMENT_ASSET', 'usdc');
const TIMEOUT_MS = parseInt(optional('TIMEOUT_MS', '300000'), 10);

// Resolve the network passphrase — matching the sdk's defaults.
const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === 'mainnet'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function shortTxid(h) {
  return h ? `${h.slice(0, 8)}…${h.slice(-4)}` : '—';
}

async function main() {
  log(`smoke test starting`);
  log(`  api   = ${CARDS402_API_BASE}`);
  log(`  net   = ${STELLAR_NETWORK} (${NETWORK_PASSPHRASE})`);
  log(`  asset = ${PAYMENT_ASSET}`);
  log(`  amt   = ${AMOUNT_USDC} USDC`);

  const client = new Cards402Client({
    baseUrl: CARDS402_API_BASE,
    apiKey: CARDS402_API_KEY,
  });

  // ── Step 1: create order ────────────────────────────────────────────────
  log('creating order…');
  let order;
  try {
    order = await client.createOrder({
      amount_usdc: AMOUNT_USDC,
    });
  } catch (err) {
    console.error('✖ createOrder failed:', err?.message ?? err);
    process.exit(3);
  }

  log(`  order_id       = ${order.order_id}`);
  log(`  status         = ${order.status}`);
  log(`  contract_id    = ${order.payment?.contract_id}`);
  log(`  usdc.amount    = ${order.payment?.usdc?.amount}`);
  log(`  xlm.amount     = ${order.payment?.xlm?.amount ?? '(none)'}`);

  if (order.status === 'awaiting_approval') {
    console.error(
      '✖ order requires owner approval — approve it in the dashboard and rerun with resume.',
    );
    process.exit(3);
  }

  if (order.payment?.type !== 'soroban_contract') {
    console.error(`✖ unexpected payment.type: ${order.payment?.type} (expected soroban_contract)`);
    process.exit(3);
  }

  // ── Step 2: pay via contract ────────────────────────────────────────────
  log('building + signing + submitting Soroban contract call…');
  let txHash;
  try {
    txHash = await payViaContract({
      walletSecret: STELLAR_WALLET_SECRET,
      payment: order.payment,
      paymentAsset: PAYMENT_ASSET,
      networkPassphrase: NETWORK_PASSPHRASE,
      sorobanRpcUrl: SOROBAN_RPC_URL ?? undefined,
    });
  } catch (err) {
    console.error('✖ payViaContract failed:', err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exit(3);
  }

  log(`  ✓ contract call accepted: ${shortTxid(txHash)}`);

  // ── Step 3: poll until terminal ─────────────────────────────────────────
  log(`polling /v1/orders/${order.order_id} (timeout ${TIMEOUT_MS / 1000}s)…`);
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await client.getOrder(order.order_id);
    } catch (err) {
      log(`  poll error: ${err?.message ?? err} — retrying`);
      await sleep(3000);
      continue;
    }
    log(`  phase=${last.phase} status=${last.status}`);

    if (last.phase === 'ready') {
      log('  ✓ card delivered');
      console.log('');
      console.log(`  order_id  : ${last.order_id}`);
      console.log(`  phase     : ${last.phase}`);
      console.log(`  card.brand: ${last.card?.brand ?? 'Visa'}`);
      console.log(`  card.last4: ${(last.card?.number ?? '').slice(-4)}`);
      console.log(`  card.exp  : ${last.card?.expiry}`);
      console.log('');
      log('smoke test PASSED');
      process.exit(0);
    }

    if (last.phase === 'failed' || last.phase === 'refunded' || last.phase === 'rejected') {
      console.error(`✖ order landed in terminal-fail phase: ${last.phase}`);
      if (last.error) console.error(`  error: ${last.error}`);
      if (last.refund?.stellar_txid) console.error(`  refund txid: ${last.refund.stellar_txid}`);
      process.exit(1);
    }
    if (last.phase === 'expired') {
      console.error('✖ order expired waiting for payment — did the contract call actually land?');
      process.exit(1);
    }

    await sleep(3000);
  }

  console.error(
    `✖ timed out waiting for terminal phase; last seen: phase=${last?.phase} status=${last?.status}`,
  );
  process.exit(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('✖ unhandled error:', err?.stack ?? err);
  process.exit(3);
});
