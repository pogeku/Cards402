// Full pipeline: place CTX order → pay XLM → scrape stage1 → scrape stage2 → print card details
// Usage: node run-pipeline.js [amount]  (default: 0.02)
require('dotenv').config();
const { createGiftCard, getGiftCard } = require('./src/ctx/client');
const { payCtxOrder } = require('./src/payments/xlm-sender');
const { scrapeStage1 } = require('./src/scraper/stage1');
const { scrapeStage2 } = require('./src/scraper/stage2');

async function main() {
  const amount = process.argv[2] || '0.02';
  const log = (...args) => console.log(...args);

  // 1. Place order
  log(`\n=== Step 1: Place $${amount} CTX order ===`);
  const order = await createGiftCard(amount);
  log(`Order ID: ${order.id}`);
  log(`XLM to send: ${order.paymentCryptoAmount}`);

  // 2. Pay
  log(`\n=== Step 2: Pay with XLM ===`);
  const txHash = await payCtxOrder(order.paymentUrls.XLM);
  log(`TX hash: ${txHash}`);

  // 3. Poll for fulfillment
  log(`\n=== Step 3: Wait for CTX fulfillment ===`);
  let redeemUrl, challenge;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const o = await getGiftCard(order.id);
    log(`  status: ${o.fulfilmentStatus} / ${o.paymentStatus}`);
    if (o.fulfilmentStatus === 'complete' || o.fulfilmentStatus === 'fulfilled') {
      redeemUrl = o.redeemUrl;
      challenge = o.redeemUrlChallenge;
      log(`  redeemUrl: [redacted — one-time use URL]`);
      log(`  challenge: [redacted]`);
      break;
    }
    if (['failed', 'error', 'cancelled'].includes(o.fulfilmentStatus)) {
      throw new Error(`CTX order failed: ${o.fulfilmentStatus}`);
    }
  }
  if (!redeemUrl) throw new Error('Timed out waiting for fulfillment');

  // 4. Stage 1 scrape
  log(`\n=== Step 4: Stage 1 scrape (claims.storedvalue.com) ===`);
  const stage1 = await scrapeStage1(redeemUrl, challenge, log);
  log(`Stage 1 result: success=${stage1.success} brand=${stage1.brand || 'unknown'}`);
  if (!stage1.success || !stage1.rewardUrl) {
    throw new Error(`Stage 1 failed: ${stage1.error}`);
  }

  // 5. Stage 2 scrape — IMMEDIATELY after stage1 (link is one-time use)
  log(`\n=== Step 5: Stage 2 scrape (vcdelivery.com → yourrewardcard.com) ===`);
  const stage2 = await scrapeStage2(stage1.rewardUrl, log);

  if (stage2.success) {
    log(`\n=== CARD RETRIEVED ===`);
    log(`Card Number: ****${String(stage2.cardNumber).slice(-4)}`);
    log(`Expiry:      ${stage2.expiry}`);
    log(`(CVV not logged)`);
  } else {
    log(`\n=== STAGE 2 FAILED: ${stage2.error} ===`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
