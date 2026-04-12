/**
 * Admin dashboard E2E tests.
 *
 * The admin page (page.tsx) calls `http://localhost:4000/auth/*` and `/admin/*`
 * from the browser. We intercept all those requests with page.route() so no real
 * backend is needed. The tests exercise the full UI flow:
 *   email OTP login → dashboard → CRUD → state changes.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_EMAIL = 'owner@example.com';
const MOCK_CODE = '123456';
const MOCK_TOKEN = 'mock-bearer-token-xyz';

const MOCK_SYSTEM_OK = { frozen: '0', consecutive_failures: '0' };
const MOCK_SYSTEM_FROZEN = { frozen: '1', consecutive_failures: '3' };

const MOCK_STATS = {
  total_orders: 42,
  total_gmv: 315.0,
  delivered: 38,
  failed: 3,
  refunded: 1,
  pending: 0,
  refund_pending: 0,
  active_keys: 2,
};

const MOCK_KEYS = [
  {
    id: 'key-id-1',
    label: 'my-agent',
    spend_limit_usdc: '100.00',
    total_spent_usdc: '55.00',
    default_webhook_url: null,
    enabled: 1,
    created_at: '2025-01-15T12:00:00Z',
  },
  {
    id: 'key-id-2',
    label: 'research-bot',
    spend_limit_usdc: null,
    total_spent_usdc: '260.00',
    default_webhook_url: 'https://example.com/wh',
    enabled: 1,
    created_at: '2025-02-01T09:00:00Z',
  },
];

const MOCK_ORDERS = [
  {
    id: 'order-id-aabbccdd-1122',
    status: 'delivered',
    amount_usdc: '10.00',
    payment_asset: 'usdc',
    error: null,
    created_at: '2025-03-01T10:00:00Z',
    stellar_txid: null,
    card_brand: 'Visa',
    api_key_label: 'my-agent',
  },
  {
    id: 'order-id-eeff0011-3344',
    status: 'failed',
    amount_usdc: '25.00',
    payment_asset: 'xlm',
    error: 'CTX unavailable',
    created_at: '2025-03-02T11:00:00Z',
    stellar_txid: null,
    card_brand: null,
    api_key_label: 'research-bot',
  },
];

// ── API mock helpers ──────────────────────────────────────────────────────────

/** Intercept auth and admin API calls and serve mock data. */
async function mockAdminApi(page: Page, overrides: {
  system?: object;
  stats?: object;
  orders?: object[];
  keys?: object[];
} = {}) {
  const system = overrides.system ?? MOCK_SYSTEM_OK;
  const stats = overrides.stats ?? MOCK_STATS;
  const orders = overrides.orders ?? MOCK_ORDERS;
  const keys = overrides.keys ?? MOCK_KEYS;

  // Auth endpoints
  await page.route('**/auth/login', (route) => {
    route.fulfill({ json: { ok: true } });
  });
  await page.route('**/auth/verify', (route) => {
    route.fulfill({ json: { token: MOCK_TOKEN, user: { id: 'u1', email: MOCK_EMAIL, role: 'owner' } } });
  });
  await page.route('**/auth/logout', (route) => {
    route.fulfill({ json: { ok: true } });
  });

  // Admin data endpoints
  await page.route('**/admin/system', (route) => {
    route.fulfill({ json: system });
  });
  await page.route('**/admin/stats', (route) => {
    route.fulfill({ json: stats });
  });
  await page.route('**/admin/orders**', (route) => {
    route.fulfill({ json: orders });
  });
  await page.route('**/admin/api-keys', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ json: keys });
    } else if (route.request().method() === 'POST') {
      route.fulfill({
        status: 201,
        json: {
          id: 'new-key-id',
          key: 'cards402_abc123def456',
          webhook_secret: 'whsec_testwebhooksecret12345',
          label: 'new-agent',
          warning: 'Store this key securely — it will not be shown again.',
        },
      });
    } else {
      route.continue();
    }
  });

  // Other admin endpoints (approvals, users, policy decisions, etc.)
  await page.route('**/admin/**', (route) => {
    route.fulfill({ json: [] });
  });
}

/** Log in to the admin dashboard via email OTP flow. */
async function login(page: Page) {
  // Step 1: enter email and request code
  await page.fill('input[type="email"]', MOCK_EMAIL);
  await page.click('button:has-text("Send code")');

  // Step 2: enter code and verify
  await page.waitForSelector('input[placeholder="123456"]');
  await page.fill('input[placeholder="123456"]', MOCK_CODE);
  await page.click('button:has-text("Verify")');

  await page.waitForSelector('h1:has-text("Dashboard")');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Admin login', () => {
  test('shows login form when not authenticated', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('h1')).toContainText('Sign in');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('button:has-text("Send code")')).toBeVisible();
  });

  test('Send code button is disabled when email is empty', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('button:has-text("Send code")')).toBeDisabled();
  });

  test('advances to code step after entering email', async ({ page }) => {
    await page.route('**/auth/login', (route) => route.fulfill({ json: { ok: true } }));
    await page.goto('/admin');
    await page.fill('input[type="email"]', MOCK_EMAIL);
    await page.click('button:has-text("Send code")');
    await expect(page.locator('h1')).toContainText('Check your email');
    await expect(page.locator('input[placeholder="123456"]')).toBeVisible();
  });

  test('logs in and shows dashboard after OTP verify', async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible();
  });

  test('back button returns to email step', async ({ page }) => {
    await page.route('**/auth/login', (route) => route.fulfill({ json: { ok: true } }));
    await page.goto('/admin');
    await page.fill('input[type="email"]', MOCK_EMAIL);
    await page.click('button:has-text("Send code")');
    await page.waitForSelector('button:has-text("Back")');
    await page.click('button:has-text("Back")');
    await expect(page.locator('h1')).toContainText('Sign in');
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('sign out clears session and returns to login', async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
    await page.click('button:has-text("Sign out")');
    await expect(page.locator('h1')).toContainText('Sign in');
  });

  test('shows error when verify fails', async ({ page }) => {
    await page.route('**/auth/login', (route) => route.fulfill({ json: { ok: true } }));
    await page.route('**/auth/verify', (route) => {
      route.fulfill({ status: 401, json: { error: 'invalid_code', message: 'Invalid or expired code.' } });
    });
    await page.goto('/admin');
    await page.fill('input[type="email"]', MOCK_EMAIL);
    await page.click('button:has-text("Send code")');
    await page.waitForSelector('input[placeholder="123456"]');
    await page.fill('input[placeholder="123456"]', '000000');
    await page.click('button:has-text("Verify")');
    await expect(page.getByText('Invalid or expired code.')).toBeVisible();
  });
});

test.describe('Admin dashboard — stats bar', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
  });

  test('shows GMV stat', async ({ page }) => {
    await expect(page.getByText('$315.00')).toBeVisible();
  });

  test('shows order counts', async ({ page }) => {
    await expect(page.getByText('42')).toBeVisible(); // total orders
    await expect(page.getByText('38')).toBeVisible(); // delivered
  });

  test('shows "System OK" when not frozen', async ({ page }) => {
    await expect(page.getByText('System OK')).toBeVisible();
  });
});

test.describe('Admin dashboard — frozen system', () => {
  test('shows FROZEN badge and Unfreeze button', async ({ page }) => {
    await mockAdminApi(page, { system: MOCK_SYSTEM_FROZEN });
    await page.goto('/admin');
    await login(page);

    await expect(page.getByText('FROZEN')).toBeVisible();
    await expect(page.locator('button:has-text("Unfreeze")')).toBeVisible();
  });

  test('clicking Unfreeze calls unfreeze endpoint and refreshes', async ({ page }) => {
    await mockAdminApi(page, { system: MOCK_SYSTEM_FROZEN });
    await page.goto('/admin');
    await login(page);

    let unfreezeCalled = false;
    await page.route('**/admin/system/unfreeze', (route) => {
      unfreezeCalled = true;
      route.fulfill({ status: 200, json: { ok: true } });
    });
    // After unfreeze, system returns OK
    await page.route('**/admin/system', (route) => {
      route.fulfill({ json: MOCK_SYSTEM_OK });
    });

    await page.click('button:has-text("Unfreeze")');
    await expect(async () => {
      expect(unfreezeCalled).toBe(true);
    }).toPass();
  });
});

test.describe('Admin dashboard — orders table', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
  });

  test('shows orders in the table', async ({ page }) => {
    await expect(page.locator('table').first()).toBeVisible();
    // Order IDs are truncated to 12 chars + ellipsis; match first 12 chars of mock ID
    await expect(page.getByText(/order-id-aab/)).toBeVisible();
  });

  test('shows status badges', async ({ page }) => {
    await expect(page.getByText('delivered').first()).toBeVisible();
    await expect(page.getByText('failed').first()).toBeVisible();
  });

  test('shows error text for failed orders', async ({ page }) => {
    await expect(page.getByText('CTX unavailable')).toBeVisible();
  });

  test('shows "No orders yet." when list is empty', async ({ page }) => {
    await mockAdminApi(page, { orders: [] });
    await page.goto('/admin');
    await login(page);
    await expect(page.getByText('No orders yet.')).toBeVisible();
  });
});

test.describe('Admin dashboard — API keys', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
  });

  test('lists API keys with labels', async ({ page }) => {
    // Use role=cell to avoid matching the filter dropdown <option> elements
    await expect(page.getByRole('cell', { name: 'my-agent' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'research-bot' }).first()).toBeVisible();
  });

  test('shows spend bars for keys with limits', async ({ page }) => {
    // SpendBar shows "$55.00 / $100.00"
    await expect(page.getByText('$55.00 / $100.00')).toBeVisible();
  });

  test('shows unlimited spend for keys without limit', async ({ page }) => {
    // SpendBar with no limit shows "$260.00 / ∞"
    await expect(page.getByText('$260.00 / ∞')).toBeVisible();
  });

  test('shows enabled badge for active keys', async ({ page }) => {
    const enabledBadges = page.getByText('enabled');
    await expect(enabledBadges.first()).toBeVisible();
  });
});

test.describe('Admin dashboard — create key modal', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
  });

  test('opens create modal on "+ Create API key" click', async ({ page }) => {
    await page.click('button:has-text("+ Create API key")');
    await expect(page.locator('h2:has-text("Create API key")')).toBeVisible();
  });

  test('creates key and shows credentials after submit', async ({ page }) => {
    await page.click('button:has-text("+ Create API key")');
    await page.fill('input[placeholder="my-agent"]', 'new-agent');
    await page.click('button:has-text("Create key")');

    // Should display the new API key and webhook secret
    await expect(page.getByText('cards402_abc123def456')).toBeVisible();
    await expect(page.getByText('whsec_testwebhooksecret12345')).toBeVisible();
    await expect(page.getByText('Copy both values now')).toBeVisible();
  });

  test('shows "Done" button after key creation', async ({ page }) => {
    await page.click('button:has-text("+ Create API key")');
    await page.click('button:has-text("Create key")');
    await expect(page.locator('button:has-text("Done")')).toBeVisible();
  });

  test('closes modal on backdrop click', async ({ page }) => {
    await page.click('button:has-text("+ Create API key")');
    await expect(page.locator('h2:has-text("Create API key")')).toBeVisible();
    // Click the backdrop (outside the modal box)
    await page.mouse.click(10, 10);
    await expect(page.locator('h2:has-text("Create API key")')).not.toBeVisible();
  });

  test('closes modal on Cancel click', async ({ page }) => {
    await page.click('button:has-text("+ Create API key")');
    await page.click('button:has-text("Cancel")');
    await expect(page.locator('h2:has-text("Create API key")')).not.toBeVisible();
  });
});

test.describe('Admin dashboard — edit key modal', () => {
  test.beforeEach(async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);
  });

  test('opens edit modal when Edit button is clicked', async ({ page }) => {
    await page.locator('button:has-text("Edit")').first().click();
    await expect(page.locator('h2:has-text("Edit API key")')).toBeVisible();
  });

  test('pre-fills current label in edit modal', async ({ page }) => {
    await page.locator('button:has-text("Edit")').first().click();
    const labelInput = page.locator('input[placeholder="my-agent"]');
    await expect(labelInput).toHaveValue('my-agent');
  });

  test('saves changes and calls PATCH endpoint', async ({ page }) => {
    let patchBody: object | null = null;
    await page.route('**/admin/api-keys/key-id-1', (route: Route) => {
      if (route.request().method() === 'PATCH') {
        patchBody = route.request().postDataJSON();
        route.fulfill({ status: 200, json: { id: 'key-id-1', label: 'updated-agent' } });
      } else {
        route.continue();
      }
    });

    await page.locator('button:has-text("Edit")').first().click();
    const labelInput = page.locator('input[placeholder="my-agent"]');
    await labelInput.fill('updated-agent');
    await page.click('button:has-text("Save changes")');

    await expect(async () => {
      expect(patchBody).not.toBeNull();
    }).toPass({ timeout: 3000 });
  });

  test('closes without saving when Cancel is clicked', async ({ page }) => {
    await page.locator('button:has-text("Edit")').first().click();
    await page.click('button:has-text("Cancel")');
    await expect(page.locator('h2:has-text("Edit API key")')).not.toBeVisible();
  });
});

test.describe('Admin dashboard — key enable/disable', () => {
  test('clicking Disable calls PATCH with enabled=false', async ({ page }) => {
    await mockAdminApi(page);
    await page.goto('/admin');
    await login(page);

    let patchCalled = false;
    await page.route('**/admin/api-keys/key-id-1', (route: Route) => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true;
        route.fulfill({ status: 200, json: {} });
      } else {
        route.continue();
      }
    });

    await page.locator('button:has-text("Disable")').first().click();
    await expect(async () => {
      expect(patchCalled).toBe(true);
    }).toPass({ timeout: 3000 });
  });
});

test.describe('Admin dashboard — backend error state', () => {
  test('shows error when verify returns 401', async ({ page }) => {
    await page.route('**/auth/login', (route) => route.fulfill({ json: { ok: true } }));
    await page.route('**/auth/verify', (route) => {
      route.fulfill({ status: 401, json: { error: 'invalid_code', message: 'Invalid or expired code.' } });
    });

    await page.goto('/admin');
    await page.fill('input[type="email"]', MOCK_EMAIL);
    await page.click('button:has-text("Send code")');
    await page.waitForSelector('input[placeholder="123456"]');
    await page.fill('input[placeholder="123456"]', '000000');
    await page.click('button:has-text("Verify")');

    await expect(page.getByText('Invalid or expired code.')).toBeVisible();
  });
});
