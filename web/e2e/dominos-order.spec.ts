/**
 * Domino's UK — full checkout automation (plausibility study)
 *
 * Run:
 *   cd web
 *   CARD_NUMBER=4111111111111111 CARD_CVV=123 npx playwright test dominos-order --headed --project=chromium
 *
 * Set DRY_RUN=false to actually submit the order:
 *   DRY_RUN=false CARD_NUMBER=... CARD_CVV=... npx playwright test dominos-order --headed --project=chromium
 */

import { test, type Page, type FrameLocator } from '@playwright/test';

// ── config ────────────────────────────────────────────────────────────────────

const CARD = {
  number:   process.env.CARD_NUMBER    ?? '',
  expMonth: process.env.CARD_EXP_MONTH ?? '12',
  expYear:  process.env.CARD_EXP_YEAR  ?? '2027',
  cvv:      process.env.CARD_CVV       ?? '',
};

const ORDER = {
  postcode:  process.env.POSTCODE    ?? 'EC1A 1BB',
  address1:  process.env.ADDRESS1    ?? '1 Test Street',
  firstName: process.env.FIRST_NAME  ?? 'Alex',
  lastName:  process.env.LAST_NAME   ?? 'Agent',
  email:     process.env.EMAIL       ?? 'agent@example.com',
  phone:     process.env.PHONE       ?? '07700900000',
};

const DRY_RUN = process.env.DRY_RUN !== 'false';

test.use({ baseURL: '' });
test.setTimeout(180_000);

// ── in-browser API helpers ────────────────────────────────────────────────────

type ApiResult = { status: number; body: unknown };

async function apiFetch(page: Page, path: string): Promise<ApiResult> {
  return page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text }; }
  }, path.startsWith('http') ? path : `https://www.dominos.co.uk${path}`);
}

async function apiPost(page: Page, path: string, body: unknown): Promise<ApiResult> {
  return page.evaluate(async ([url, payload]) => {
    const xsrf = document.cookie
      .split(';').map(c => c.trim())
      .find(c => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const r = await fetch(url as string, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text }; }
  }, [path.startsWith('http') ? path : `https://www.dominos.co.uk${path}`, body] as const);
}

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

// ── stage 1: navigate to homepage, select store via postcode form ─────────────

/** Remove the OneTrust overlay if present — call after every navigation. */
async function killOverlay(page: Page) {
  await page.evaluate(() => {
    document.getElementById('onetrust-consent-sdk')?.remove();
    (document.querySelector('.onetrust-pc-dark-filter') as HTMLElement | null)?.remove();
  }).catch(() => {});
}

async function stage1_selectStore(page: Page): Promise<{ storeId: string; storeSlug: string }> {
  // Step 1: Load homepage to establish session + XSRF, accept cookie consent
  log('store', 'loading dominos.co.uk…');
  await page.goto('https://www.dominos.co.uk', { waitUntil: 'domcontentloaded' });

  // Accept cookie consent (sets OptanonConsent cookie; reveals the store finder popup)
  // Do NOT make any API calls before this — the Vue app may intercept them and close the popup
  const cookieBtn = page.locator('#onetrust-accept-btn-handler').first();
  if (await cookieBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await cookieBtn.click();
    log('store', 'cookie consent accepted');
    // Wait briefly for the overlay fade to complete, then remove its DOM node
    await page.waitForTimeout(600);
    await killOverlay(page);
  }

  // Enter postcode in the now-visible store finder popup
  const postcodeInput = page.locator('input[placeholder="Enter your postcode"], input[placeholder*="postcode" i]').first();
  await postcodeInput.waitFor({ timeout: 12_000 });
  await postcodeInput.fill(ORDER.postcode);
  await postcodeInput.press('Enter');
  await page.waitForLoadState('networkidle');
  await killOverlay(page);
  log('store', 'postcode submitted');

  // Trigger the first store link via JS — bypasses Playwright's overlay pointer check.
  // The SPA click handler sets up the delivery session and adds ?menuId=...&fulfilment=Delivery.
  const clicked = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/store/"][href*="/menu"]') as HTMLAnchorElement | null;
    if (link) { link.click(); return link.href; }
    return null;
  });
  log('store', `store link clicked: ${clicked ?? '(not found)'}`);
  await page.waitForLoadState('networkidle');
  await killOverlay(page);

  // Now that we're on the menu with an established session, fetch store metadata
  await apiFetch(page, '/Store/Reset'); // bootstrap XSRF
  const search = await apiFetch(
    page,
    `/storefindermap/storesearch?SearchText=${encodeURIComponent(ORDER.postcode)}&DistanceUnit=Miles&SearchType=All`
  );
  log('store', `store search → HTTP ${search.status}`);

  // Parse store ID from URL (most reliable) or API response
  const urlMatch = page.url().match(/\/store\/(\d+)\/([^/?]+)/);
  const storeId   = urlMatch?.[1] ?? String((search.body as { localStore?: { id?: number } })?.localStore?.id ?? '');
  const storeSlug = urlMatch?.[2] ?? '';
  log('store', `on menu — store ${storeId} — ${page.url()}`);
  return { storeId, storeSlug };
}

// ── stage 2: add pizza to basket via UI — intercept the basket API call ────────

async function stage2_addToBasket(page: Page, _storeId: string): Promise<string> {
  log('basket', 'intercepting API calls to capture product/basket format…');

  // Capture basket API calls so we can learn the real add-item format
  const capturedRequests: Array<{ url: string; method: string; postData: string }> = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/api/baskets') || url.includes('/basket') || url.includes('product')) {
      capturedRequests.push({ url, method: req.method(), postData: req.postData() ?? '' });
    }
  });

  // Probe the basket state first
  const basket = await apiFetch(page, '/api/baskets/v1/baskets');
  log('basket', `basket state → HTTP ${basket.status}`);
  const basketData = (basket.body as { data?: { id?: string; menuId?: string } })?.data;
  const basketId = basketData?.id ?? '';
  const menuId   = basketData?.menuId ?? '';
  log('basket', `basket ID: ${basketId} / menu ID: ${menuId}`);

  // Click "Add to Order" on any pizza — the cheapest is usually a Margherita
  // Look for any product card with an add button
  const addBtn = page.locator(
    'button:has-text("Add to Order"), button:has-text("Add"), [data-testid*="add" i], .product-card button, .product__add'
  ).first();
  await addBtn.waitFor({ timeout: 15_000 });
  log('basket', 'clicking Add to Order…');
  await addBtn.click();

  // Handle size picker modal if it appears
  await page.waitForTimeout(1000);
  const sizeOpt = page.locator(
    '.pizza-size, [data-testid*="size" i], button:has-text("Medium"), button:has-text("Small"), .size-option'
  ).first();
  if (await sizeOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sizeOpt.click();
    log('basket', 'size selected');
    await page.waitForTimeout(500);
  }

  // Confirm / add to order button in the modal
  const confirmBtn = page.locator(
    'button:has-text("Add to Order"), button:has-text("Confirm"), button:has-text("Add to Basket")'
  ).last();
  if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmBtn.click();
  }

  await page.waitForTimeout(1500);

  // Log any basket API calls the UI triggered (tells us the real request format)
  if (capturedRequests.length > 0) {
    log('basket', 'captured API calls:');
    capturedRequests.forEach(r => console.log(`  ${r.method} ${r.url}\n  body: ${r.postData.slice(0, 200)}`));
  }

  // Verify basket now has items
  const basket2 = await apiFetch(page, '/api/baskets/v1/baskets');
  const itemCount = (basket2.body as { data?: { itemCount?: number } })?.data?.itemCount ?? 0;
  log('basket', `basket now has ${itemCount} item(s)`);
  console.log('basket after add:', JSON.stringify(basket2.body).slice(0, 400));

  return basketId;
}

// ── stage 3: navigate to checkout, set delivery details ──────────────────────

async function stage3_checkout(page: Page, storeId: string, storeSlug: string) {
  // Try the SPA checkout route for this store
  const checkoutUrl = `https://www.dominos.co.uk/store/${storeId}/${storeSlug}/checkout`;
  log('checkout', `navigating to ${checkoutUrl}`);
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  log('checkout', `landed on: ${page.url()}`);

  // Also try clicking the basket/cart icon if we ended up back on the menu
  if (page.url().includes('/menu')) {
    log('checkout', 'redirected to menu — looking for basket / checkout button');
    const cartBtn = page.locator(
      'button:has-text("Checkout"), a:has-text("Checkout"), [data-testid*="basket" i], .basket-btn, .cart-btn, button[aria-label*="basket" i]'
    ).first();
    if (await cartBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cartBtn.click();
      await page.waitForLoadState('networkidle');
      log('checkout', `after basket click: ${page.url()}`);
    }
  }

  // Guest path
  const guestBtn = page.locator(
    'button:has-text("Guest"), a:has-text("Guest"), button:has-text("Order as Guest"), button:has-text("Continue as Guest")'
  ).first();
  if (await guestBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await guestBtn.click();
    await page.waitForLoadState('networkidle');
    log('checkout', 'guest path selected');
  }

  log('checkout', `checkout page: ${page.url()}`);

  // Try the yourdetails API
  const details = await apiPost(page, '/fulfilment/yourdetails', {
    FirstName:    ORDER.firstName,
    LastName:     ORDER.lastName,
    Email:        ORDER.email,
    PhoneNumber:  ORDER.phone,
    AddressLine1: ORDER.address1,
    Postcode:     ORDER.postcode,
  });
  log('checkout', `yourdetails → HTTP ${details.status}`);
  console.log('yourdetails:', JSON.stringify(details.body).slice(0, 400));

  if (details.status >= 400) {
    log('checkout', 'API rejected — filling UI form');
    await page.locator('#FirstName, [name="FirstName"], [placeholder*="first name" i]').first().fill(ORDER.firstName).catch(() => {});
    await page.locator('#LastName,  [name="LastName"],  [placeholder*="last name" i]').first().fill(ORDER.lastName).catch(() => {});
    await page.locator('#Email,     [name="Email"],     [type="email"]').first().fill(ORDER.email).catch(() => {});
    await page.locator('#PhoneNumber, [name="PhoneNumber"], [type="tel"]').first().fill(ORDER.phone).catch(() => {});
    const addr = page.locator('#AddressLine1, [name="AddressLine1"], [placeholder*="address" i]').first();
    if (await addr.isVisible({ timeout: 2000 }).catch(() => false)) await addr.fill(ORDER.address1);
    await page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').first().click().catch(() => {});
    await page.waitForLoadState('networkidle');
  }

  // Probe payments/initiate
  const payInit = await apiFetch(page, '/checkout/api/payments/initiate');
  log('checkout', `payments/initiate → HTTP ${payInit.status}`);
  console.log('payments/initiate:', JSON.stringify(payInit.body).slice(0, 600));
}

// ── stage 4: fill CyberSource Flex Microform, optionally submit ───────────────
//
// Iframe nesting (confirmed from live browser session):
//   └── iframe[src*="CybersourceFlexCardFrame"]
//         ├── #cardNumber > iframe    (flex.cybersource.com, fieldType=number)
//         └── #securityCode > iframe  (flex.cybersource.com, fieldType=securityCode)

async function stage4_payment(page: Page) {
  log('payment', 'waiting for CyberSource card frame…');
  await page.waitForSelector(
    'iframe[src*="CybersourceFlexCardFrame"], iframe[src*="PaymentCard"], iframe[title*="payment" i]',
    { timeout: 20_000 }
  );
  await page.waitForTimeout(2500); // Flex JS needs time to inject sub-iframes

  const cardFrame: FrameLocator = page.frameLocator(
    'iframe[src*="CybersourceFlexCardFrame"], iframe[src*="PaymentCard"], iframe[title*="payment" i]'
  );

  const numberFrame = cardFrame.frameLocator('#cardNumber iframe');
  await numberFrame.locator('input').waitFor({ timeout: 8000 });
  await numberFrame.locator('input').fill(CARD.number);
  log('payment', 'card number entered');

  await cardFrame.locator('#expMonth').selectOption(CARD.expMonth);
  await cardFrame.locator('#expYear').selectOption(CARD.expYear);
  log('payment', `expiry ${CARD.expMonth}/${CARD.expYear}`);

  const cvvFrame = cardFrame.frameLocator('#securityCode iframe');
  await cvvFrame.locator('input').waitFor({ timeout: 8000 });
  await cvvFrame.locator('input').fill(CARD.cvv);
  log('payment', 'CVV entered');

  if (DRY_RUN) {
    log('payment', '⚠  DRY_RUN=true — form filled, NOT submitted');
    log('payment', '   Set DRY_RUN=false to place the order');
    await page.waitForTimeout(20_000);
    return;
  }

  log('payment', '🍕 placing order…');
  await cardFrame.locator('#btnsubmit').click();

  const confirmed = await page
    .locator('h1:has-text("Thank you"), h1:has-text("Order confirmed"), .order-confirmation')
    .isVisible({ timeout: 30_000 })
    .catch(() => false);

  if (confirmed) {
    log('payment', '✓ Order placed!');
  } else {
    await page.screenshot({ path: 'dominos-post-submit.png' });
    log('payment', '⚠  No confirmation page — screenshot saved');
  }
}

// ── test ──────────────────────────────────────────────────────────────────────

test('order pizza from Dominos UK', async ({ page }) => {
  if (!CARD.number || !CARD.cvv) {
    test.skip(true, 'Set CARD_NUMBER and CARD_CVV env vars');
  }

  const { storeId, storeSlug } = await stage1_selectStore(page);
  await stage2_addToBasket(page, storeId);
  await stage3_checkout(page, storeId, storeSlug);
  await stage4_payment(page);
});
