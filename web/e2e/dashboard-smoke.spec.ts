/**
 * Dashboard smoke tests — renders every top-level dashboard route
 * against a mocked backend and asserts:
 *   1. no uncaught page errors
 *   2. no console.error logs
 *   3. the expected page heading is present
 *
 * Intentionally light on assertions per page — the point is to catch
 * crashes and infinite-loop bugs (like React error #185) before they
 * hit prod, not to unit-test component behaviour.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const MOCK_USER = {
  id: 'user-id-1',
  email: 'owner@example.com',
  role: 'owner',
};

const MOCK_DASHBOARD_INFO = {
  id: 'dash-id-1',
  name: 'Test Dashboard',
  spend_limit_usdc: null,
  frozen: false,
  created_at: '2026-04-01T00:00:00Z',
  stats: {
    total_orders: 12,
    total_gmv: 150,
    delivered: 10,
    failed: 1,
    refunded: 1,
    pending: 0,
    active_keys: 2,
    pending_approvals: 0,
  },
};

const MOCK_AGENTS = [
  {
    id: 'agent-1',
    label: 'test-agent',
    spend_limit_usdc: '100.00',
    total_spent_usdc: '55.00',
    default_webhook_url: null,
    wallet_public_key: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ',
    enabled: 1,
    suspended: 0,
    last_used_at: '2026-04-13T12:00:00Z',
    created_at: '2026-04-01T00:00:00Z',
    policy_daily_limit_usdc: null,
    policy_single_tx_limit_usdc: null,
    policy_require_approval_above_usdc: null,
    policy_allowed_hours: null,
    policy_allowed_days: null,
    mode: 'live',
    rate_limit_rpm: null,
    expires_at: null,
    agent: {
      state: 'active',
      label: 'Active',
      detail: null,
      since: '2026-04-01T00:00:00Z',
      wallet_public_key: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ',
    },
  },
];

const MOCK_ORDERS = [
  {
    id: 'order-1',
    status: 'delivered',
    amount_usdc: '10.00',
    payment_asset: 'usdc',
    error: null,
    created_at: '2026-04-12T10:00:00Z',
    updated_at: '2026-04-12T10:00:30Z',
    stellar_txid: 'abc123def456',
    card_brand: 'VISA',
    api_key_id: 'agent-1',
    api_key_label: 'test-agent',
  },
];

const MOCK_MERCHANT = {
  id: 'a6c7a007-016b-4f90-9180-0a173cfeaf57',
  name: 'Visa® eReward Card',
  logo_url: 'https://example.com/logo.png',
  card_image_url: 'https://example.com/card.png',
  country: 'US',
  currency: 'USD',
  discount_pct: 4.5,
  min_amount: 5,
  max_amount: 500,
  redeem_location: 'online',
  redeem_type: 'link',
  enabled: true,
  description: 'Test merchant',
};

const MOCK_ALERT_RULE = {
  id: 'rule-1',
  dashboard_id: 'dash-id-1',
  name: 'Test rule',
  kind: 'ctx_auth_dead',
  config: {},
  enabled: true,
  snoozed_until: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const MOCK_AUDIT_ENTRY = {
  id: 1,
  dashboard_id: 'dash-id-1',
  actor_user_id: 'user-id-1',
  actor_email: 'owner@example.com',
  actor_role: 'owner',
  action: 'agent.create',
  resource_type: 'agent',
  resource_id: 'agent-1',
  details: { label: 'test-agent' },
  ip: '127.0.0.1',
  user_agent: 'smoke-test',
  created_at: '2026-04-13T12:00:00Z',
};

const MOCK_WEBHOOK_DELIVERY = {
  id: 1,
  dashboard_id: 'dash-id-1',
  api_key_id: 'agent-1',
  url: 'https://example.com/webhook',
  method: 'POST',
  request_body: { order_id: 'order-1', status: 'delivered' },
  response_status: 200,
  response_body: '{"ok":true}',
  latency_ms: 45,
  error: null,
  signature: 'sha256=abc123',
  created_at: '2026-04-13T12:00:00Z',
};

// ── Mock installation ────────────────────────────────────────────────────────

async function installMocks(page: Page) {
  // Auth
  await page.route('**/api/auth/me', (route: Route) =>
    route.fulfill({ status: 200, json: { user: MOCK_USER } }),
  );
  await page.route('**/api/auth/logout', (route: Route) =>
    route.fulfill({ status: 200, json: { ok: true } }),
  );

  // Admin proxy — each sub-path returns a plausible payload
  await page.route('**/api/admin-proxy/dashboard', (route: Route) =>
    route.fulfill({ status: 200, json: MOCK_DASHBOARD_INFO }),
  );
  // NOTE: the real backend returns bare arrays for these three legacy
  // list endpoints (not wrapped objects). Mocks MUST match or the
  // provider's normaliser won't be tested against production shape.
  await page.route('**/api/admin-proxy/dashboard/api-keys**', (route: Route) =>
    route.fulfill({ status: 200, json: MOCK_AGENTS }),
  );
  await page.route('**/api/admin-proxy/dashboard/orders**', (route: Route) =>
    route.fulfill({ status: 200, json: MOCK_ORDERS }),
  );
  await page.route('**/api/admin-proxy/dashboard/approval-requests**', (route: Route) =>
    route.fulfill({ status: 200, json: [] }),
  );
  await page.route('**/api/admin-proxy/dashboard/merchants', (route: Route) =>
    route.fulfill({ status: 200, json: { merchants: [MOCK_MERCHANT] } }),
  );
  await page.route('**/api/admin-proxy/dashboard/alert-rules', (route: Route) =>
    route.fulfill({ status: 200, json: { rules: [MOCK_ALERT_RULE] } }),
  );
  await page.route('**/api/admin-proxy/dashboard/alert-firings**', (route: Route) =>
    route.fulfill({ status: 200, json: { firings: [] } }),
  );
  await page.route('**/api/admin-proxy/dashboard/audit-log**', (route: Route) =>
    route.fulfill({ status: 200, json: { entries: [MOCK_AUDIT_ENTRY] } }),
  );
  await page.route('**/api/admin-proxy/dashboard/webhook-deliveries**', (route: Route) =>
    route.fulfill({ status: 200, json: { deliveries: [MOCK_WEBHOOK_DELIVERY] } }),
  );

  // SSE stream — return an empty event-stream so the EventSource attaches
  // and immediately ends. The dashboard's reconnect backoff handles that
  // gracefully (it just retries on a 2s timer which the test never waits for).
  await page.route('**/api/admin-proxy/dashboard/stream', (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: ':connected\n\n',
    }),
  );

  // Horizon balance polling — return an empty account
  await page.route('**horizon.stellar.org/accounts/**', (route: Route) =>
    route.fulfill({ status: 200, json: { balances: [] } }),
  );
}

// ── Error collection hooks ───────────────────────────────────────────────────

function attachErrorCollectors(page: Page) {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // Next.js development server emits noisy warnings we don't care about
      // (Fast Refresh, hydration hints from RSC) — filter them out.
      const text = msg.text();
      if (
        text.includes('[Fast Refresh]') ||
        text.includes('Failed to load resource') ||
        text.includes('Download the React DevTools') ||
        text.includes('hydration')
      ) {
        return;
      }
      consoleErrors.push(text);
    }
  });
  return { errors, consoleErrors };
}

// ── Route smoke tests ────────────────────────────────────────────────────────

const ROUTES: Array<{ path: string; heading: RegExp }> = [
  { path: '/dashboard/overview', heading: /Overview/ },
  { path: '/dashboard/agents', heading: /Agents/ },
  { path: '/dashboard/agents/agent-1', heading: /test-agent/ },
  { path: '/dashboard/orders', heading: /Orders/ },
  { path: '/dashboard/approvals', heading: /Approvals/ },
  { path: '/dashboard/analytics', heading: /Analytics/ },
  { path: '/dashboard/merchants', heading: /Merchants/ },
  { path: '/dashboard/alerts', heading: /Alerts/ },
  { path: '/dashboard/audit', heading: /Audit log/ },
  { path: '/dashboard/developer', heading: /Developer/ },
  { path: '/dashboard/settings', heading: /Settings/ },
  { path: '/dashboard/teams', heading: /Teams/ },
  { path: '/dashboard/feedback', heading: /Feedback/ },
];

test.describe('Dashboard route smoke', () => {
  for (const { path, heading } of ROUTES) {
    test(`${path} renders without errors`, async ({ page }) => {
      await installMocks(page);
      const { errors, consoleErrors } = attachErrorCollectors(page);

      await page.goto(path);
      // Give DashboardProvider a tick to hydrate + refresh
      await page.waitForLoadState('networkidle', { timeout: 10_000 });

      // Assert the page heading rendered
      await expect(page.locator('main')).toContainText(heading, { timeout: 5_000 });

      // No page-level errors
      expect(errors, `page errors on ${path}: ${errors.join(' | ')}`).toEqual([]);
      // No console.error calls from our own code
      expect(consoleErrors, `console errors on ${path}: ${consoleErrors.join(' | ')}`).toEqual([]);
    });
  }
});

test.describe('Dashboard shell', () => {
  test('sidebar renders all expected nav links for an owner', async ({ page }) => {
    await installMocks(page);
    await page.goto('/dashboard/overview');
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    const sidebar = page.locator('aside').first();
    for (const label of [
      'Overview',
      'Agents',
      'Orders',
      'Approvals',
      'Analytics',
      'Merchants',
      'Webhooks',
      'Alerts',
      'Audit log',
      'Teams',
      'Settings',
      'Feedback',
    ]) {
      await expect(sidebar).toContainText(label);
    }
  });

  test('command palette opens on Cmd+K and lists nav commands', async ({ page }) => {
    await installMocks(page);
    await page.goto('/dashboard/overview');
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await page.keyboard.press('Meta+k');
    const palette = page.getByPlaceholder('Type a command or search…');
    await expect(palette).toBeVisible();

    await palette.fill('agents');
    await expect(page.getByText('Go to Agents')).toBeVisible();
  });
});

test.describe('Coming soon UI', () => {
  test('Teams page shows Coming soon pill and disabled form', async ({ page }) => {
    await installMocks(page);
    await page.goto('/dashboard/teams');
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await expect(page.getByText('Coming soon').first()).toBeVisible();
    // Invite button is disabled
    const inviteButton = page.getByRole('button', { name: '+ Invite member' });
    await expect(inviteButton).toBeDisabled();
  });

  test('Agent detail shows auto top-up Coming soon section', async ({ page }) => {
    await installMocks(page);
    await page.goto('/dashboard/agents/agent-1');
    await page.waitForLoadState('networkidle', { timeout: 10_000 });

    await expect(page.getByText('Auto top-up', { exact: true })).toBeVisible();
    await expect(page.getByText('Coming soon').first()).toBeVisible();
    const enableButton = page.getByRole('button', { name: /Enable auto top-up/ });
    await expect(enableButton).toBeDisabled();
  });
});
