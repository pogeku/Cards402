// Analytics aggregations tests.

import { describe, it, expect } from 'vitest';
import { spendByAgent, latencyStats, errorBreakdown, marginSummary } from './analytics';
import type { ApiKey, Order } from './types';

function makeAgent(id: string, label: string): ApiKey {
  return {
    id,
    label,
    spend_limit_usdc: null,
    total_spent_usdc: '0',
    default_webhook_url: null,
    wallet_public_key: null,
    enabled: 1,
    suspended: 0,
    last_used_at: null,
    created_at: '2026-04-01T00:00:00Z',
    policy_daily_limit_usdc: null,
    policy_single_tx_limit_usdc: null,
    policy_require_approval_above_usdc: null,
    policy_allowed_hours: null,
    policy_allowed_days: null,
    mode: 'live',
    rate_limit_rpm: null,
    expires_at: null,
  };
}

function makeOrder(partial: Partial<Order>): Order {
  return {
    id: 'order-default',
    status: 'delivered',
    amount_usdc: '10',
    payment_asset: 'usdc',
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stellar_txid: null,
    card_brand: 'VISA',
    api_key_id: 'agent-1',
    api_key_label: 'Agent 1',
    ...partial,
  };
}

describe('spendByAgent', () => {
  it('aggregates delivered revenue per agent', () => {
    const agents = [makeAgent('a1', 'Alice'), makeAgent('a2', 'Bob')];
    const now = new Date().toISOString();
    const orders = [
      makeOrder({
        id: '1',
        api_key_id: 'a1',
        amount_usdc: '10',
        status: 'delivered',
        created_at: now,
        updated_at: now,
      }),
      makeOrder({
        id: '2',
        api_key_id: 'a1',
        amount_usdc: '20',
        status: 'delivered',
        created_at: now,
        updated_at: now,
      }),
      makeOrder({
        id: '3',
        api_key_id: 'a2',
        amount_usdc: '15',
        status: 'delivered',
        created_at: now,
        updated_at: now,
      }),
      makeOrder({
        id: '4',
        api_key_id: 'a1',
        amount_usdc: '5',
        status: 'failed',
        created_at: now,
        updated_at: now,
      }),
    ];
    const result = spendByAgent(orders, agents, 86_400_000);
    expect(result).toHaveLength(2);
    const alice = result.find((r) => r.apiKeyId === 'a1');
    const bob = result.find((r) => r.apiKeyId === 'a2');
    expect(alice?.amount).toBe(30);
    expect(alice?.count).toBe(3);
    expect(bob?.amount).toBe(15);
  });

  it('drops orders outside the window', () => {
    const agents = [makeAgent('a1', 'Alice')];
    const orders = [
      makeOrder({
        id: '1',
        api_key_id: 'a1',
        amount_usdc: '100',
        status: 'delivered',
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:01Z',
      }),
    ];
    const result = spendByAgent(orders, agents, 86_400_000);
    expect(result).toHaveLength(0);
  });

  it('computes success rate from delivered vs failed+refunded', () => {
    const agents = [makeAgent('a1', 'Alice')];
    const now = new Date().toISOString();
    const orders = [
      makeOrder({
        id: '1',
        api_key_id: 'a1',
        status: 'delivered',
        created_at: now,
        updated_at: now,
      }),
      makeOrder({
        id: '2',
        api_key_id: 'a1',
        status: 'delivered',
        created_at: now,
        updated_at: now,
      }),
      makeOrder({ id: '3', api_key_id: 'a1', status: 'failed', created_at: now, updated_at: now }),
    ];
    const result = spendByAgent(orders, agents, 86_400_000);
    expect(result[0]?.successRate).toBeCloseTo(2 / 3, 2);
  });
});

describe('latencyStats', () => {
  it('returns zeros when there are no delivered orders', () => {
    const result = latencyStats([]);
    expect(result.samples).toBe(0);
    expect(result.p50).toBe(0);
  });

  it('computes min / mean / p50 / p95', () => {
    // 5 delivered orders with known latencies: 10s, 20s, 30s, 40s, 50s
    const orders = [10, 20, 30, 40, 50].map((secs, i) => {
      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.parse(start) + secs * 1000).toISOString();
      return makeOrder({ id: `o${i}`, status: 'delivered', created_at: start, updated_at: end });
    });
    const result = latencyStats(orders);
    expect(result.samples).toBe(5);
    expect(result.min).toBe(10);
    expect(result.max).toBe(50);
    expect(result.mean).toBe(30);
    expect(result.p50).toBe(30);
  });

  it('buckets latencies into fixed ranges', () => {
    const orders = [5, 25, 75, 500].map((secs, i) => {
      const start = new Date(Date.now() - 600_000).toISOString();
      const end = new Date(Date.parse(start) + secs * 1000).toISOString();
      return makeOrder({ id: `o${i}`, status: 'delivered', created_at: start, updated_at: end });
    });
    const result = latencyStats(orders);
    const first = result.buckets[0];
    expect(first).toBeDefined();
    expect(first?.count).toBeGreaterThan(0);
  });
});

describe('errorBreakdown', () => {
  it('groups failed orders by short reason', () => {
    const orders = [
      makeOrder({
        id: '1',
        status: 'failed',
        error: 'Wallet balance was too low. Top up and retry.',
      }),
      makeOrder({
        id: '2',
        status: 'failed',
        error: 'Wallet balance was too low. Top up and retry.',
      }),
      makeOrder({
        id: '3',
        status: 'refunded',
        error: 'The order could not be fulfilled. Try again.',
      }),
    ];
    const result = errorBreakdown(orders, 5);
    expect(result).toHaveLength(2);
    expect(result[0]?.count).toBe(2);
  });

  it('returns unknown for orders with null error', () => {
    const result = errorBreakdown([makeOrder({ status: 'failed', error: null })]);
    expect(result[0]?.reason).toBe('Unknown');
  });

  it('ignores non-failed orders', () => {
    const result = errorBreakdown([
      makeOrder({ status: 'delivered' }),
      makeOrder({ status: 'pending_payment' }),
    ]);
    expect(result).toHaveLength(0);
  });
});

describe('marginSummary', () => {
  it('computes revenue, CTX cost, and margin with default 2.5% discount', () => {
    const orders = [
      makeOrder({ id: '1', status: 'delivered', amount_usdc: '100' }),
      makeOrder({ id: '2', status: 'delivered', amount_usdc: '50' }),
      makeOrder({ id: '3', status: 'failed', amount_usdc: '20' }),
    ];
    const result = marginSummary(orders);
    expect(result.revenue).toBe(150);
    expect(result.estimatedCtxCost).toBeCloseTo(150 * 0.975, 2);
    expect(result.estimatedMargin).toBeCloseTo(150 * 0.025, 2);
    expect(result.marginPct).toBeCloseTo(2.5, 2);
    expect(result.deliveredCount).toBe(2);
  });

  it('returns zeros when there are no delivered orders', () => {
    const result = marginSummary([]);
    expect(result.revenue).toBe(0);
    expect(result.marginPct).toBe(0);
  });

  it('honours a custom discount', () => {
    const orders = [makeOrder({ status: 'delivered', amount_usdc: '100' })];
    const result = marginSummary(orders, 10);
    expect(result.estimatedMargin).toBeCloseTo(10, 2);
  });
});
