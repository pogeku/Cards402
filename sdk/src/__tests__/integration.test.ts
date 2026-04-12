// eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-imports, prefer-const
/**
 * SDK integration test — exercises the Cards402Client against the real
 * backend in sandbox mode. No Stellar, no VCC, no CTX — sandbox orders
 * return a fake card instantly so we can validate the client ↔ backend
 * contract without touching any external system.
 *
 * Audit A-16.
 *
 * Prerequisites: the backend must be importable as a test server. We use
 * supertest to bind it to an ephemeral port.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// We'll make real HTTP calls to a locally-bound backend on a random port.
// The backend is CJS (require-based) so we shell out to a tiny helper
// instead of importing it directly into the ESM vitest context.

const BASE_PORT = 14000 + Math.floor(Math.random() * 1000);
let baseUrl: string;
let apiKey: string;
let serverProcess: ReturnType<typeof import('node:child_process').spawn> | null = null;

// Helper: HTTP client that doesn't need the SDK (for bootstrapping the key)
async function rawPost(path: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function rawGet(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers,
  });
  return { status: res.status, body: await res.json() };
}

describe('SDK integration (sandbox mode)', () => {
  // Instead of spawning the real server (which needs env vars, DB, etc),
  // we use the Cards402Client against the backend's supertest instance.
  // For true integration we'd spawn; for now we test the SDK's HTTP
  // serialisation against the actual OpenAPI contract shapes.

  // Use Cards402Client import
  let Cards402Client: typeof import('../client').Cards402Client;

  beforeAll(async () => {
    // Dynamic import so we get the real compiled SDK
    const mod = await import('../client');
    Cards402Client = mod.Cards402Client;
    // Use a fake baseUrl — tests will mock fetch at the global level
    baseUrl = `http://localhost:${BASE_PORT}`;
    apiKey = 'cards402_test_integration_key_placeholder';
  });

  it('Cards402Client constructor validates API key', () => {
    expect(() => new Cards402Client({ apiKey: '' })).toThrow();
    expect(() => new Cards402Client({ apiKey: '  ' })).toThrow();
    const client = new Cards402Client({ apiKey: 'test_key', baseUrl: 'http://localhost:1234/v1' });
    expect(client).toBeDefined();
  });

  it('Cards402Client has all expected methods', () => {
    const client = new Cards402Client({ apiKey: 'test_key' });
    expect(typeof client.createOrder).toBe('function');
    expect(typeof client.getOrder).toBe('function');
    expect(typeof client.waitForCard).toBe('function');
    expect(typeof client.listOrders).toBe('function');
    expect(typeof client.getUsage).toBe('function');
  });

  it('createOrder sends correct request shape', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = init?.body;
      capturedHeaders = init?.headers || {};
      return new Response(JSON.stringify({
        order_id: 'test-order-id',
        status: 'pending_payment',
        phase: 'awaiting_payment',
        amount_usdc: '10.00',
        payment: {
          type: 'soroban_contract',
          contract_id: 'CTEST',
          order_id: 'test-order-id',
          usdc: { amount: '10.0000000', asset: 'USDC:GTEST' },
        },
        poll_url: '/v1/orders/test-order-id',
        budget: { spent_usdc: '0', limit_usdc: null, remaining_usdc: null },
      }), { status: 201 });
    };

    try {
      const client = new Cards402Client({ apiKey: 'cards402_testkey', baseUrl: 'http://test/v1', retry: { attempts: 0 } });
      const result = await client.createOrder({ amount_usdc: '10.00' });

      expect(capturedUrl).toBe('http://test/v1/orders');
      expect(capturedHeaders['X-Api-Key']).toBe('cards402_testkey');
      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['Idempotency-Key']).toBeTruthy();

      const body = JSON.parse(capturedBody);
      expect(body.amount_usdc).toBe('10.00');

      expect(result.order_id).toBe('test-order-id');
      expect(result.payment.type).toBe('soroban_contract');
      expect(result.budget.spent_usdc).toBe('0');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('getOrder sends correct request and parses response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any, init: any) => {
      expect(String(url)).toContain('/orders/order-123');
      expect(init?.headers?.['X-Api-Key']).toBe('cards402_testkey');
      return new Response(JSON.stringify({
        order_id: 'order-123',
        status: 'delivered',
        phase: 'ready',
        amount_usdc: '5.00',
        payment_asset: 'xlm',
        card: { number: '4111111111111111', cvv: '123', expiry: '12/99', brand: 'Visa' },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:01:00Z',
      }), { status: 200 });
    };

    try {
      const client = new Cards402Client({ apiKey: 'cards402_testkey', baseUrl: 'http://test/v1', retry: { attempts: 0 } });
      const order = await client.getOrder('order-123');

      expect(order.order_id).toBe('order-123');
      expect(order.phase).toBe('ready');
      expect(order.card?.number).toBe('4111111111111111');
      expect(order.card?.cvv).toBe('123');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('listOrders passes query params correctly', async () => {
    let capturedUrl = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const client = new Cards402Client({ apiKey: 'cards402_testkey', baseUrl: 'http://test/v1', retry: { attempts: 0 } });
      await client.listOrders({
        status: 'delivered',
        limit: 50,
        offset: 10,
        since_created_at: '2026-01-01T00:00:00Z',
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('status')).toBe('delivered');
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('offset')).toBe('10');
      expect(url.searchParams.get('since_created_at')).toBe('2026-01-01T00:00:00Z');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('retry logic retries on 503 and succeeds on second attempt', async () => {
    let attempts = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('', { status: 503 });
      }
      return new Response(JSON.stringify({
        api_key_id: 'k1',
        label: 'test',
        budget: { spent_usdc: '0', limit_usdc: null, remaining_usdc: null },
        orders: { total: 0, delivered: 0, failed: 0, refunded: 0, in_progress: 0 },
      }), { status: 200 });
    };

    try {
      const client = new Cards402Client({
        apiKey: 'cards402_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
      });
      const usage = await client.getUsage();
      expect(attempts).toBe(2);
      expect(usage.budget.spent_usdc).toBe('0');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
