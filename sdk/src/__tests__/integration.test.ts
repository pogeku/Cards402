/**
 * SDK integration test — exercises Cards402Client's HTTP serialisation
 * against the OpenAPI contract shapes by stubbing global fetch. No
 * Stellar, no VCC, no CTX.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Allow http:// base URLs in tests (assertSafeBaseUrl rejects them otherwise)
process.env.CARDS402_ALLOW_INSECURE_BASE_URL = '1';

import type { Cards402Client as Cards402ClientType } from '../client';

describe('SDK integration (sandbox mode)', () => {
  let Cards402Client: typeof Cards402ClientType;

  beforeAll(async () => {
    const mod = await import('../client');
    Cards402Client = mod.Cards402Client;
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
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      capturedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
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
        }),
        { status: 201 },
      );
    }) as typeof fetch;

    try {
      const client = new Cards402Client({
        apiKey: 'cards402_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 0 },
      });
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
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain('/orders/order-123');
      const headers = (init?.headers || {}) as Record<string, string>;
      expect(headers['X-Api-Key']).toBe('cards402_testkey');
      return new Response(
        JSON.stringify({
          order_id: 'order-123',
          status: 'delivered',
          phase: 'ready',
          amount_usdc: '5.00',
          payment_asset: 'xlm',
          card: { number: '4111111111111111', cvv: '123', expiry: '12/99', brand: 'Visa' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:01:00Z',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const client = new Cards402Client({
        apiKey: 'cards402_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 0 },
      });
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
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new Cards402Client({
        apiKey: 'cards402_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 0 },
      });
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
      return new Response(
        JSON.stringify({
          api_key_id: 'k1',
          label: 'test',
          budget: { spent_usdc: '0', limit_usdc: null, remaining_usdc: null },
          orders: { total: 0, delivered: 0, failed: 0, refunded: 0, in_progress: 0 },
        }),
        { status: 200 },
      );
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
