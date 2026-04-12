# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dominos-order.spec.ts >> order pizza from Dominos UK
- Location: e2e/dominos-order.spec.ts:326:5

# Error details

```
TimeoutError: locator.waitFor: Timeout 12000ms exceeded.
Call log:
  - waiting for locator('input[placeholder="Enter your postcode"], input[placeholder*="postcode" i]').first() to be visible

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - img [ref=e2]
  - generic [ref=e6]:
    - banner [ref=e7]:
      - generic [ref=e10]:
        - navigation [ref=e11]:
          - list "Account navigation" [ref=e12]:
            - listitem [ref=e13]:
              - link "Register" [ref=e14] [cursor=pointer]:
                - /url: /mydominos/register
            - listitem [ref=e15]:
              - text: "|"
              - link "Log In" [ref=e16] [cursor=pointer]:
                - /url: /mydominos/login
        - link "Domino's pizza" [ref=e17] [cursor=pointer]:
          - /url: /
          - img [ref=e19]
    - generic [ref=e26]:
      - generic [ref=e30]:
        - heading "Order pizza near you" [level=1] [ref=e31]:
          - generic [ref=e32]:
            - img [ref=e33]
            - text: Order pizza near you
            - img [ref=e35]
        - generic [ref=e38]:
          - img
          - generic [ref=e39]:
            - heading "Enter your postcode" [level=4] [ref=e41]
            - paragraph [ref=e43]: Your postcode helps us show the local menu and deals at your store.
        - generic [ref=e48]:
          - textbox "Enter your postcode" [ref=e49]:
            - /placeholder: Type here
          - generic: Enter your postcode
        - generic [ref=e50]:
          - button "Delivery" [disabled] [ref=e51]:
            - generic [ref=e53]: Delivery
          - button "Collect" [disabled] [ref=e54]:
            - generic [ref=e56]: Collect
      - link "Price Slice Deals" [ref=e58] [cursor=pointer]:
        - /url: "#{SP}#/deals"
        - img "Price Slice Deals" [ref=e60]
      - heading "Pizza delivery or collection" [level=1] [ref=e62]:
        - generic [ref=e63]:
          - img [ref=e64]
          - text: Pizza delivery or collection
          - img [ref=e66]
      - heading "Welcome to Domino's, the UK's favourite pizza takeaway! Get pizza delivery near you, or collect from your local store." [level=3] [ref=e69]
      - generic [ref=e71]:
        - heading "View deals" [level=2] [ref=e73] [cursor=pointer]
        - heading "Browse menu" [level=2] [ref=e75] [cursor=pointer]
      - generic [ref=e79]:
        - link "Chick 'N' Dip" [ref=e82] [cursor=pointer]:
          - /url: "#{SP}#/menu#chick-n-dip"
          - img "Chick 'N' Dip" [ref=e84]
        - link "Dominos mobile app" [ref=e87] [cursor=pointer]:
          - /url: https://dominosuk.page.link/tzH3
          - img "Dominos mobile app" [ref=e89]
        - generic [ref=e92]:
          - img "Pizza tracker" [ref=e94]
          - paragraph [ref=e95]: "T&Cs Apply: See Boring Legal Stuff"
    - contentinfo [ref=e97]:
      - generic [ref=e99]:
        - generic [ref=e100]:
          - heading "About Domino's" [level=2] [ref=e101]:
            - generic [ref=e102]: About Domino's
          - navigation "About Domino's" [ref=e103]:
            - list [ref=e104]:
              - listitem "About us" [ref=e105]:
                - link "About us" [ref=e106] [cursor=pointer]:
                  - /url: https://corporate.dominos.co.uk/about-us
                  - img
                  - generic [ref=e107]: About us
              - listitem "Our Vision, Purpose and Values" [ref=e108]:
                - link "Our Vision, Purpose and Values" [ref=e109] [cursor=pointer]:
                  - /url: https://corporate.dominos.co.uk/vision-purpose-values
                  - img
                  - generic [ref=e110]: Our Vision, Purpose and Values
              - listitem "Allergens & Nutrition" [ref=e111]:
                - link "Allergens & Nutrition" [ref=e112] [cursor=pointer]:
                  - /url: https://corporate.dominos.co.uk/allergens-nutritional
                  - img
                  - generic [ref=e113]: Allergens & Nutrition
              - listitem "Contact Us" [ref=e114]:
                - link "Contact Us" [ref=e115] [cursor=pointer]:
                  - /url: /contact
                  - img
                  - generic [ref=e116]: Contact Us
        - generic [ref=e117]:
          - heading "Corporate" [level=2] [ref=e118]:
            - generic [ref=e119]: Corporate
          - navigation "Corporate" [ref=e120]:
            - list [ref=e121]:
              - listitem "Franchising" [ref=e122]:
                - link "Franchising" [ref=e123] [cursor=pointer]:
                  - /url: https://corporate.dominos.co.uk/franchising
                  - img
                  - generic [ref=e124]: Franchising
              - listitem "Investor Relations" [ref=e125]:
                - link "Investor Relations" [ref=e126] [cursor=pointer]:
                  - /url: https://investors.dominos.co.uk/investors/overview
                  - img
                  - generic [ref=e127]: Investor Relations
              - listitem "Media" [ref=e128]:
                - link "Media" [ref=e129] [cursor=pointer]:
                  - /url: https://corporate.dominos.co.uk/media-area
                  - img
                  - generic [ref=e130]: Media
              - listitem "Working For Us" [ref=e131]:
                - link "Working For Us" [ref=e132] [cursor=pointer]:
                  - /url: https://corporate.dominos.co.uk/working-for-us
                  - img
                  - generic [ref=e133]: Working For Us
        - generic [ref=e134]:
          - heading "Follow Us" [level=2] [ref=e135]
          - navigation "Domino's Socials" [ref=e136]:
            - list [ref=e137]:
              - listitem [ref=e138]:
                - link "Facebook" [ref=e139] [cursor=pointer]:
                  - /url: https://www.facebook.com/DominosPizza
                  - img "Facebook" [ref=e140]
              - listitem [ref=e141]:
                - link "Twitter" [ref=e142] [cursor=pointer]:
                  - /url: https://twitter.com/Dominos_UK
                  - img "Twitter" [ref=e143]
              - listitem [ref=e144]:
                - link "Instagram" [ref=e145] [cursor=pointer]:
                  - /url: https://www.instagram.com/dominos_uk/?hl=en
                  - img "Instagram" [ref=e146]
              - listitem [ref=e147]:
                - link "Youtube" [ref=e148] [cursor=pointer]:
                  - /url: https://www.youtube.com/channel/UC2rjTzAKJmjvdbr4ssII4fg
                  - img "Youtube" [ref=e149]
              - listitem [ref=e150]:
                - link "Tik Tok" [ref=e151] [cursor=pointer]:
                  - /url: https://www.tiktok.com/@dominos_uki
                  - img "Tik Tok" [ref=e152]
              - listitem [ref=e153]:
                - link "Blog" [ref=e154] [cursor=pointer]:
                  - /url: https://www.dominos.co.uk/blog/
                  - img "Blog" [ref=e155]
          - img "Domino's" [ref=e157]
      - generic [ref=e159]:
        - navigation "Legal" [ref=e160]:
          - list [ref=e161]:
            - listitem [ref=e162]:
              - link "Pizza Near Me" [ref=e163] [cursor=pointer]:
                - /url: /pizza-near-me/
            - listitem [ref=e164]:
              - text: "|"
              - link "Domino's deals" [ref=e165] [cursor=pointer]:
                - /url: /blog/vouchers/
            - listitem [ref=e166]:
              - text: "|"
              - link "Student discount" [ref=e167] [cursor=pointer]:
                - /url: /blog/students/
            - listitem [ref=e168]:
              - text: "|"
              - link "Terms of Use" [ref=e169] [cursor=pointer]:
                - /url: /legal/content/termsofuse
            - listitem [ref=e170]:
              - text: "|"
              - link "Terms and Conditions" [ref=e171] [cursor=pointer]:
                - /url: /legal/content/termsandconditions
            - listitem [ref=e172]:
              - text: "|"
              - link "Privacy Policy" [ref=e173] [cursor=pointer]:
                - /url: /legal/content/privacypolicy
            - listitem [ref=e174]:
              - text: "|"
              - link "Marketing Preferences" [ref=e175] [cursor=pointer]:
                - /url: /marketingpreferences
            - listitem [ref=e176]:
              - text: "|"
              - link "Cookie Policy" [ref=e177] [cursor=pointer]:
                - /url: /legal/content/cookiepolicy
            - listitem [ref=e178]:
              - text: "|"
              - link "Copyright and Legal" [ref=e179] [cursor=pointer]:
                - /url: /legal/content/copyrightandlegal
            - listitem [ref=e180]:
              - text: "|"
              - link "Boring Legal Stuff" [ref=e181] [cursor=pointer]:
                - /url: /legal/content/index
        - paragraph [ref=e183]: © 2026 Domino's Pizza UK and Ireland Limited
  - region "Cookie banner" [active] [ref=e186]:
    - dialog "Cookies" [ref=e187]:
      - generic [ref=e188]:
        - generic [ref=e189]:
          - generic:
            - heading "Cookies" [level=2] [ref=e190]
            - generic [ref=e191]:
              - text: These cookies are set by us and third party companies on your device to measure site usage, personalise your site experience and to assist in our marketing efforts. Click 'Accept Cookies' to consent, or 'Reject Advertising' to see less targeted advertising. If you choose to reject Advertising cookies, we may still use Analytics and Personalisation cookies to optimise our websites and personalise your experience. To manage your preferences across all cookie categories, please click 'Manage Settings'.
              - link "More information about your privacy, opens in a new tab" [ref=e192] [cursor=pointer]:
                - /url: https://www.dominos.co.uk/legal/content/cookiepolicy
                - text: Cookie Policy
        - generic [ref=e195]:
          - button "Manage Settings, Opens the preference center dialog" [ref=e197] [cursor=pointer]: Manage Settings
          - generic [ref=e198]:
            - button "Reject Advertising" [ref=e199] [cursor=pointer]
            - button "Accept" [ref=e200] [cursor=pointer]
```

# Test source

```ts
  2   |  * Domino's UK — full checkout automation (plausibility study)
  3   |  *
  4   |  * Run:
  5   |  *   cd web
  6   |  *   CARD_NUMBER=4111111111111111 CARD_CVV=123 npx playwright test dominos-order --headed --project=chromium
  7   |  *
  8   |  * Set DRY_RUN=false to actually submit the order:
  9   |  *   DRY_RUN=false CARD_NUMBER=... CARD_CVV=... npx playwright test dominos-order --headed --project=chromium
  10  |  */
  11  | 
  12  | import { test, type Page, type FrameLocator } from '@playwright/test';
  13  | 
  14  | // ── config ────────────────────────────────────────────────────────────────────
  15  | 
  16  | const CARD = {
  17  |   number:   process.env.CARD_NUMBER    ?? '',
  18  |   expMonth: process.env.CARD_EXP_MONTH ?? '12',
  19  |   expYear:  process.env.CARD_EXP_YEAR  ?? '2027',
  20  |   cvv:      process.env.CARD_CVV       ?? '',
  21  | };
  22  | 
  23  | const ORDER = {
  24  |   postcode:  process.env.POSTCODE    ?? 'EC1A 1BB',
  25  |   address1:  process.env.ADDRESS1    ?? '1 Test Street',
  26  |   firstName: process.env.FIRST_NAME  ?? 'Alex',
  27  |   lastName:  process.env.LAST_NAME   ?? 'Agent',
  28  |   email:     process.env.EMAIL       ?? 'agent@example.com',
  29  |   phone:     process.env.PHONE       ?? '07700900000',
  30  | };
  31  | 
  32  | const DRY_RUN = process.env.DRY_RUN !== 'false';
  33  | 
  34  | test.use({ baseURL: '' });
  35  | test.setTimeout(180_000);
  36  | 
  37  | // ── in-browser API helpers ────────────────────────────────────────────────────
  38  | 
  39  | type ApiResult = { status: number; body: unknown };
  40  | 
  41  | async function apiFetch(page: Page, path: string): Promise<ApiResult> {
  42  |   return page.evaluate(async (url) => {
  43  |     const r = await fetch(url, { credentials: 'include' });
  44  |     const text = await r.text();
  45  |     try { return { status: r.status, body: JSON.parse(text) }; }
  46  |     catch { return { status: r.status, body: text }; }
  47  |   }, path.startsWith('http') ? path : `https://www.dominos.co.uk${path}`);
  48  | }
  49  | 
  50  | async function apiPost(page: Page, path: string, body: unknown): Promise<ApiResult> {
  51  |   return page.evaluate(async ([url, payload]) => {
  52  |     const xsrf = document.cookie
  53  |       .split(';').map(c => c.trim())
  54  |       .find(c => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
  55  |     const r = await fetch(url as string, {
  56  |       method: 'POST',
  57  |       credentials: 'include',
  58  |       headers: {
  59  |         'Content-Type': 'application/json',
  60  |         ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}),
  61  |       },
  62  |       body: JSON.stringify(payload),
  63  |     });
  64  |     const text = await r.text();
  65  |     try { return { status: r.status, body: JSON.parse(text) }; }
  66  |     catch { return { status: r.status, body: text }; }
  67  |   }, [path.startsWith('http') ? path : `https://www.dominos.co.uk${path}`, body] as const);
  68  | }
  69  | 
  70  | function log(step: string, msg: string) {
  71  |   console.log(`[${step}] ${msg}`);
  72  | }
  73  | 
  74  | // ── stage 1: navigate to homepage, select store via postcode form ─────────────
  75  | 
  76  | /** Remove the OneTrust overlay if present — call after every navigation. */
  77  | async function killOverlay(page: Page) {
  78  |   await page.evaluate(() => {
  79  |     document.getElementById('onetrust-consent-sdk')?.remove();
  80  |     (document.querySelector('.onetrust-pc-dark-filter') as HTMLElement | null)?.remove();
  81  |   }).catch(() => {});
  82  | }
  83  | 
  84  | async function stage1_selectStore(page: Page): Promise<{ storeId: string; storeSlug: string }> {
  85  |   // Step 1: Load homepage to establish session + XSRF, accept cookie consent
  86  |   log('store', 'loading dominos.co.uk…');
  87  |   await page.goto('https://www.dominos.co.uk', { waitUntil: 'domcontentloaded' });
  88  | 
  89  |   // Accept cookie consent (sets OptanonConsent cookie; reveals the store finder popup)
  90  |   // Do NOT make any API calls before this — the Vue app may intercept them and close the popup
  91  |   const cookieBtn = page.locator('#onetrust-accept-btn-handler').first();
  92  |   if (await cookieBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
  93  |     await cookieBtn.click();
  94  |     log('store', 'cookie consent accepted');
  95  |     // Wait briefly for the overlay fade to complete, then remove its DOM node
  96  |     await page.waitForTimeout(600);
  97  |     await killOverlay(page);
  98  |   }
  99  | 
  100 |   // Enter postcode in the now-visible store finder popup
  101 |   const postcodeInput = page.locator('input[placeholder="Enter your postcode"], input[placeholder*="postcode" i]').first();
> 102 |   await postcodeInput.waitFor({ timeout: 12_000 });
      |                       ^ TimeoutError: locator.waitFor: Timeout 12000ms exceeded.
  103 |   await postcodeInput.fill(ORDER.postcode);
  104 |   await postcodeInput.press('Enter');
  105 |   await page.waitForLoadState('networkidle');
  106 |   await killOverlay(page);
  107 |   log('store', 'postcode submitted');
  108 | 
  109 |   // Trigger the first store link via JS — bypasses Playwright's overlay pointer check.
  110 |   // The SPA click handler sets up the delivery session and adds ?menuId=...&fulfilment=Delivery.
  111 |   const clicked = await page.evaluate(() => {
  112 |     const link = document.querySelector('a[href*="/store/"][href*="/menu"]') as HTMLAnchorElement | null;
  113 |     if (link) { link.click(); return link.href; }
  114 |     return null;
  115 |   });
  116 |   log('store', `store link clicked: ${clicked ?? '(not found)'}`);
  117 |   await page.waitForLoadState('networkidle');
  118 |   await killOverlay(page);
  119 | 
  120 |   // Now that we're on the menu with an established session, fetch store metadata
  121 |   await apiFetch(page, '/Store/Reset'); // bootstrap XSRF
  122 |   const search = await apiFetch(
  123 |     page,
  124 |     `/storefindermap/storesearch?SearchText=${encodeURIComponent(ORDER.postcode)}&DistanceUnit=Miles&SearchType=All`
  125 |   );
  126 |   log('store', `store search → HTTP ${search.status}`);
  127 | 
  128 |   // Parse store ID from URL (most reliable) or API response
  129 |   const urlMatch = page.url().match(/\/store\/(\d+)\/([^/?]+)/);
  130 |   const storeId   = urlMatch?.[1] ?? String((search.body as { localStore?: { id?: number } })?.localStore?.id ?? '');
  131 |   const storeSlug = urlMatch?.[2] ?? '';
  132 |   log('store', `on menu — store ${storeId} — ${page.url()}`);
  133 |   return { storeId, storeSlug };
  134 | }
  135 | 
  136 | // ── stage 2: add pizza to basket via UI — intercept the basket API call ────────
  137 | 
  138 | async function stage2_addToBasket(page: Page, storeId: string): Promise<string> {
  139 |   log('basket', 'intercepting API calls to capture product/basket format…');
  140 | 
  141 |   // Capture basket API calls so we can learn the real add-item format
  142 |   const capturedRequests: Array<{ url: string; method: string; postData: string }> = [];
  143 |   page.on('request', req => {
  144 |     const url = req.url();
  145 |     if (url.includes('/api/baskets') || url.includes('/basket') || url.includes('product')) {
  146 |       capturedRequests.push({ url, method: req.method(), postData: req.postData() ?? '' });
  147 |     }
  148 |   });
  149 | 
  150 |   // Probe the basket state first
  151 |   const basket = await apiFetch(page, '/api/baskets/v1/baskets');
  152 |   log('basket', `basket state → HTTP ${basket.status}`);
  153 |   const basketData = (basket.body as { data?: { id?: string; menuId?: string } })?.data;
  154 |   const basketId = basketData?.id ?? '';
  155 |   const menuId   = basketData?.menuId ?? '';
  156 |   log('basket', `basket ID: ${basketId} / menu ID: ${menuId}`);
  157 | 
  158 |   // Click "Add to Order" on any pizza — the cheapest is usually a Margherita
  159 |   // Look for any product card with an add button
  160 |   const addBtn = page.locator(
  161 |     'button:has-text("Add to Order"), button:has-text("Add"), [data-testid*="add" i], .product-card button, .product__add'
  162 |   ).first();
  163 |   await addBtn.waitFor({ timeout: 15_000 });
  164 |   log('basket', 'clicking Add to Order…');
  165 |   await addBtn.click();
  166 | 
  167 |   // Handle size picker modal if it appears
  168 |   await page.waitForTimeout(1000);
  169 |   const sizeOpt = page.locator(
  170 |     '.pizza-size, [data-testid*="size" i], button:has-text("Medium"), button:has-text("Small"), .size-option'
  171 |   ).first();
  172 |   if (await sizeOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
  173 |     await sizeOpt.click();
  174 |     log('basket', 'size selected');
  175 |     await page.waitForTimeout(500);
  176 |   }
  177 | 
  178 |   // Confirm / add to order button in the modal
  179 |   const confirmBtn = page.locator(
  180 |     'button:has-text("Add to Order"), button:has-text("Confirm"), button:has-text("Add to Basket")'
  181 |   ).last();
  182 |   if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  183 |     await confirmBtn.click();
  184 |   }
  185 | 
  186 |   await page.waitForTimeout(1500);
  187 | 
  188 |   // Log any basket API calls the UI triggered (tells us the real request format)
  189 |   if (capturedRequests.length > 0) {
  190 |     log('basket', 'captured API calls:');
  191 |     capturedRequests.forEach(r => console.log(`  ${r.method} ${r.url}\n  body: ${r.postData.slice(0, 200)}`));
  192 |   }
  193 | 
  194 |   // Verify basket now has items
  195 |   const basket2 = await apiFetch(page, '/api/baskets/v1/baskets');
  196 |   const itemCount = (basket2.body as { data?: { itemCount?: number } })?.data?.itemCount ?? 0;
  197 |   log('basket', `basket now has ${itemCount} item(s)`);
  198 |   console.log('basket after add:', JSON.stringify(basket2.body).slice(0, 400));
  199 | 
  200 |   return basketId;
  201 | }
  202 | 
```