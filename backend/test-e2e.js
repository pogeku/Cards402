// End-to-end test: create CTX order → send XLM → poll for fulfillment
require('dotenv').config();
const { createGiftCard, getGiftCard } = require('./src/ctx/client');
const { payCtxOrder } = require('./src/payments/xlm-sender');

const POLL_INTERVAL = 5000;
const TIMEOUT = 300000;
const COMPLETED_STATUSES = ['complete', 'fulfilled'];
const FAILED_STATUSES = ['failed', 'error', 'cancelled'];

async function main() {
  console.log('=== cards402 end-to-end test ===\n');

  console.log('1. Creating $0.01 gift card order with CTX...');
  const order = await createGiftCard(0.01);
  console.log(`   Order ID: ${order.id}`);
  console.log(`   XLM to send: ${order.paymentCryptoAmount}`);
  console.log(`   Payment URL: ${order.paymentUrls?.XLM}\n`);

  console.log('2. Sending XLM to CTX...');
  const xlmTxHash = await payCtxOrder(order.paymentUrls.XLM);
  console.log(`   TX hash: ${xlmTxHash}\n`);

  console.log('3. Polling CTX for fulfillment...');
  const deadline = Date.now() + TIMEOUT;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const updated = await getGiftCard(order.id);
    console.log(`   fulfilmentStatus=${updated.fulfilmentStatus} paymentStatus=${updated.paymentStatus}`);

    if (COMPLETED_STATUSES.includes(updated.fulfilmentStatus)) {
      console.log('\n=== COMPLETE — full response ===');
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    if (FAILED_STATUSES.includes(updated.fulfilmentStatus) || FAILED_STATUSES.includes(updated.paymentStatus)) {
      console.error('\n=== FAILED ===');
      console.log(JSON.stringify(updated, null, 2));
      return;
    }
  }

  console.error('Timed out waiting for fulfillment');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
