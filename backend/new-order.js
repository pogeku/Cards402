// Place a new CTX order, pay with XLM, and wait for the storedvalue.com claim URL
// Usage: node new-order.js [amount]   (default: 0.02)
require('dotenv').config();
const ctxClient = require('./src/ctx/client');
const { payCtxOrder } = require('./src/payments/xlm-sender');

async function main() {
  const amount = process.argv[2] || '0.02';
  console.log(`Placing new $${amount} CTX order...`);
  const order = await ctxClient.createGiftCard(amount);
  console.log(`CTX order: ${order.id}`);
  console.log(`Payment: ${order.paymentCryptoAmount} XLM`);
  console.log(`Payment URL: ${order.paymentUrls?.XLM}`);

  const xlmUrl = order.paymentUrls?.XLM;
  if (!xlmUrl) throw new Error('No XLM payment URL');

  console.log('\nPaying with XLM...');
  const txHash = await payCtxOrder(xlmUrl);
  console.log(`XLM sent: ${txHash}`);

  console.log('\nPolling for fulfilment...');
  const ctxOrderId = order.id;
  const deadline = Date.now() + 300000; // 5 min

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const o = await ctxClient.getGiftCard(ctxOrderId);
    console.log(`  Status: ${o.fulfilmentStatus} / ${o.paymentStatus}`);

    if (o.fulfilmentStatus === 'complete' || o.fulfilmentStatus === 'fulfilled') {
      console.log('\n=== ORDER FULFILLED ===');
      console.log('redeemUrl:', o.redeemUrl);
      console.log('redeemUrlChallenge:', o.redeemUrlChallenge);
      console.log('\nUpdate test-scraper.js with these values.');
      return;
    }

    if (o.fulfilmentStatus === 'error' || o.fulfilmentStatus === 'failed') {
      throw new Error(`CTX order failed: ${JSON.stringify(o)}`);
    }
  }

  throw new Error('Timed out waiting for CTX fulfilment');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
