// Explore yourrewardcard.com API calls after loginWithURL
// Uses Playwright to capture all network activity
require('dotenv').config();
const { chromium } = require('patchright');

// Fresh yourrewardcard.com URL from this session's stage1 run
const LOGINDETAILS_URL =
  'https://www.yourrewardcard.com/loginDetails?locale=en-US&tx_transdata=%2F0Jc2YirEz%2BQfiO1m4CNAHlHFkMym9e7ka6gU9eHy66bZ0tNtdjwhW44azBPDPSJi5XsRwAe3OSLKfz6VWl75Z4aK%2FHielVXSGRQnXBv6ysRDJqtcsvt6vaXptFJKNc3BfkrJvZtqPsDssyk5LJRij00NmCDTLcjgNUFwzUqnuStew1e2XCjjmGiVch7A61f&tx_transdataiv=8Z%2BBNcRF%2BheI5q%2Bh1905Uw%3D%3D';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  // Log all API calls
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/')) {
      console.log(`→ ${req.method()} ${url.split('?')[0]}`);
      const body = req.postData();
      if (body) console.log(`  body: ${body.slice(0, 200)}`);
      const headers = req.headers();
      const relevant = [
        'apikey',
        'slsserver',
        'x-app-name',
        'x-tmx-session-id',
        'x-ui-version',
        'authorization',
      ];
      relevant.forEach((h) => {
        if (headers[h]) console.log(`  ${h}: ${headers[h].slice(0, 50)}`);
      });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/')) {
      try {
        const body = await res.json();
        console.log(`← ${res.status()} ${url.split('?')[0]}`);
        console.log(`  response: ${JSON.stringify(body).slice(0, 500)}`);
      } catch (_) {
        console.log(`← ${res.status()} ${url.split('?')[0]} (non-JSON)`);
      }
    }
  });

  console.log('Navigating to loginDetails URL...');
  await page.goto(LOGINDETAILS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('\nWaiting 20s for API calls...');
  await page.waitForTimeout(20000);

  await page.screenshot({ path: '/tmp/stage2-api-test.png', fullPage: true });
  console.log('\nScreenshot saved to /tmp/stage2-api-test.png');

  await browser.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
