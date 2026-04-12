#!/usr/bin/env node
/**
 * cards402 Node.js agent example — order a $2 virtual Visa card using XLM.
 *
 * Prerequisites:
 *   1. npm install @ctx.com/cards402
 *   2. Set environment variables:
 *      - CARDS402_API_KEY   — from your cards402 dashboard
 *      - OWS_WALLET_NAME   — your OWS encrypted wallet name
 *      - (Optional) OWS_WALLET_PASSPHRASE
 *   3. Fund the wallet's public key (printed by createOWSWallet) with
 *      enough XLM or USDC for the order plus ~2 XLM for reserves/fees.
 *
 * Run:
 *   node index.mjs
 *
 * What it does:
 *   1. Creates a $2 order via the cards402 API
 *   2. Pays the Soroban contract from your OWS wallet
 *   3. Polls until the card is ready (~30-60s)
 *   4. Prints the card number, CVV, and expiry
 */

import { Cards402Client, purchaseCardOWS } from '@ctx.com/cards402';

const API_KEY = process.env.CARDS402_API_KEY;
const BASE_URL = process.env.CARDS402_BASE_URL || 'https://api.cards402.com/v1';
const WALLET_NAME = process.env.OWS_WALLET_NAME;

if (!API_KEY) {
  console.error('Set CARDS402_API_KEY in your environment');
  process.exit(1);
}
if (!WALLET_NAME) {
  console.error('Set OWS_WALLET_NAME in your environment');
  process.exit(1);
}

async function main() {
  console.log('Ordering a $2 virtual Visa card...\n');

  // Option A: all-in-one helper (recommended for simple use cases)
  try {
    const result = await purchaseCardOWS({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      walletName: WALLET_NAME,
      passphrase: process.env.OWS_WALLET_PASSPHRASE,
      amountUsdc: '2.00',
      paymentAsset: 'xlm',
    });

    console.log('Card delivered!\n');
    console.log(`  Number: ${result.card.number}`);
    console.log(`  CVV:    ${result.card.cvv}`);
    console.log(`  Expiry: ${result.card.expiry}`);
    console.log(`  Brand:  ${result.card.brand || 'Visa'}`);
    console.log(`  Order:  ${result.orderId}`);
    return;
  } catch (err) {
    console.error(`Purchase failed: ${err.message}`);
    process.exit(1);
  }
}

main();

/*
 * Option B: step-by-step (for more control)
 *
 * const client = new Cards402Client({ apiKey: API_KEY, baseUrl: BASE_URL });
 *
 * // 1. Create order
 * const order = await client.createOrder({ amount_usdc: '2.00' });
 * console.log(`Order ${order.order_id} created. Pay contract ${order.payment.contract_id}`);
 *
 * // 2. Pay the Soroban contract (your code — use @stellar/stellar-sdk)
 * // await payViaContract({ contractId: order.payment.contract_id, ... });
 *
 * // 3. Wait for delivery
 * const card = await client.waitForCard(order.order_id, { timeoutMs: 120000 });
 * console.log(`Card: ${card.number} CVV: ${card.cvv} Exp: ${card.expiry}`);
 */
