require('dotenv').config();
const { createGiftCard, listMerchants } = require('./src/ctx/client');

async function main() {
  console.log('Testing merchants list...');
  try {
    const merchants = await listMerchants();
    console.log('Merchants:', JSON.stringify(merchants).slice(0, 300));
  } catch (err) {
    console.log('Merchants failed:', err.message);
  }

  console.log('\nCreating $10 XLM gift card...');
  try {
    const result = await createGiftCard(10);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('Failed:', err.message);
  }
}

main();
