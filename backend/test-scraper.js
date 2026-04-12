// Test stage1 + stage2 scrape on the real fulfilled order
require('dotenv').config();
const { scrapeStage1 } = require('./src/scraper/stage1');
const { scrapeStage2 } = require('./src/scraper/stage2');

// CTX redeemUrl for the $0.02 order (7596305a) — fresh, never visited
const REDEEM_URL =
  'https://spend.ctx.com/gift-cards/cbd8668d-91b4-4a99-8132-475e291e8a70/redeem?token=eyJhbGciOiJSUzI1NiIsImtpZCI6Inl4bG9menVtUGxPQ0ZNSG00NTlZaGtWZHFHV2x6RkFmIiwidHlwIjoiZ2MifQ.eyJjaWQiOiIiLCJleHAiOjIwOTEwMzAwMzUsImlhdCI6MTc3NTY3MDAzNSwianRpIjoiaW1wc2M1eThlMmtpMHZua3NnOG45YTl3MWcxMHFqYmkiLCJ0aWQiOiJjYmQ4NjY4ZC05MWI0LTRhOTktODEzMi00NzVlMjkxZThhNzAiLCJ0dHAiOiJnaWZ0Y2FyZCJ9.T2d4Cb3CGvUPTpwGw23GzbZPrzVg8rmHhFWgffi0I2LicKG1gG3HUf-UIhtNA5NEEAWyxPvh3_xrVa84O1PaZRolSyUJCYN9fJUk_zD8TQjK1lxOSaiCFwDxd5_-CZWP2PspR87_ZJZmRbM39VM4isWLLJM3y1-kwRg3NJ2dwDmr-1O9RH_lWD128U1XKGol5c26Q1785BInKHZhcwZf3ZhiQonJIlimN3tj4Ju4F0U0XqK3GgOU_vYIKIbmbBMRCAxthPfTBLwh84svtUbeviURzwlUGKxKZ0pvJsy3VE2OGoPntmNtbXKcdU4EDgs2u5BRVIUarKJ5Q08sKuS1RA';
const CHALLENGE = 'GNQ9URKHCJ';

async function main() {
  console.log('=== Stage 1 scrape ===');
  const stage1 = await scrapeStage1(REDEEM_URL, CHALLENGE, console.log);
  console.log('\nStage 1 result:', JSON.stringify(stage1, null, 2));

  if (!stage1.success || !stage1.rewardUrl) {
    console.error('Stage 1 failed or no reward URL — stopping');
    return;
  }

  console.log('\n=== Stage 2 scrape ===');
  const stage2 = await scrapeStage2(stage1.rewardUrl, console.log);
  console.log('\nStage 2 result:', JSON.stringify(stage2, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
