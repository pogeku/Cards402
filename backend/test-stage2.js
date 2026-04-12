// Test stage2 directly against vcdelivery.com → yourrewardcard.com
// IMPORTANT: vcdelivery.com links are ONE-TIME USE.
// Run: node new-order.js && node test-scraper.js to get a fresh REWARD_URL from stage1.
require('dotenv').config();
const { scrapeStage2 } = require('./src/scraper/stage2');

// Replace with a fresh vcdelivery.com URL from stage1 output
const REWARD_URL = process.argv[2] || 'https://www.vcdelivery.com/vcert/REPLACE_WITH_FRESH_URL';

async function main() {
  if (REWARD_URL.includes('REPLACE_WITH_FRESH_URL')) {
    console.error('Usage: node test-stage2.js <vcdelivery_url>');
    console.error('Get a fresh URL by running: node test-scraper.js (stage1 output)');
    process.exit(1);
  }
  console.log('=== Stage 2 scrape ===');
  console.log(`URL: ${REWARD_URL}`);
  const result = await scrapeStage2(REWARD_URL, console.log);
  if (result.success) {
    console.log('\nStage 2: success');
    console.log(`Card: ****${String(result.cardNumber).slice(-4)}, expiry: ${result.expiry}`);
    console.log('(CVV and full PAN not logged)');
  } else {
    console.log('\nStage 2 failed:', result.error);
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
