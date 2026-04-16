// Analytics aggregations. Pure functions over the in-memory orders
// array so the analytics page doesn't need a new backend endpoint.
// Every function returns stable shapes suitable for SVG chart
// rendering in the page component.

import type { ApiKey, Order } from './types';
import { parseTimestamp } from './format';

export interface SpendByAgent {
  apiKeyId: string;
  label: string;
  amount: number;
  count: number;
  successRate: number;
}

/**
 * Collapse the orders list into per-agent totals for the given window.
 * Only delivered orders contribute to `amount`; `count` is total attempts.
 */
export function spendByAgent(orders: Order[], agents: ApiKey[], windowMs: number): SpendByAgent[] {
  const cutoff = Date.now() - windowMs;
  const byId = new Map<string, SpendByAgent>();
  for (const a of agents) {
    byId.set(a.id, {
      apiKeyId: a.id,
      label: a.label || 'Unnamed',
      amount: 0,
      count: 0,
      successRate: 1,
    });
  }
  const delivered = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const o of orders) {
    if (parseTimestamp(o.created_at) < cutoff) continue;
    const bucket = byId.get(o.api_key_id);
    if (!bucket) continue;
    bucket.count += 1;
    if (o.status === 'delivered') {
      bucket.amount += parseFloat(o.amount_usdc) || 0;
      delivered.set(o.api_key_id, (delivered.get(o.api_key_id) || 0) + 1);
    } else if (o.status === 'failed' || o.status === 'refunded') {
      failed.set(o.api_key_id, (failed.get(o.api_key_id) || 0) + 1);
    }
  }
  for (const b of byId.values()) {
    const d = delivered.get(b.apiKeyId) || 0;
    const f = failed.get(b.apiKeyId) || 0;
    const denom = d + f;
    b.successRate = denom > 0 ? d / denom : 1;
  }
  return [...byId.values()]
    .filter((b) => b.amount > 0 || b.count > 0)
    .sort((a, b) => b.amount - a.amount);
}

export interface LatencyStats {
  samples: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  buckets: { range: string; count: number }[];
}

/**
 * Order creation → delivery time in seconds, computed from the first
 * and last state transition we have locally. Uses created_at and
 * updated_at as a proxy because the row doesn't carry a delivered_at.
 */
export function latencyStats(orders: Order[]): LatencyStats {
  const samples: number[] = [];
  for (const o of orders) {
    if (o.status !== 'delivered') continue;
    const start = parseTimestamp(o.created_at);
    const end = parseTimestamp(o.updated_at);
    if (!isFinite(start) || !isFinite(end)) continue;
    const secs = (end - start) / 1000;
    if (secs <= 0 || secs > 3600) continue;
    samples.push(secs);
  }
  if (samples.length === 0) {
    return {
      samples: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      buckets: [],
    };
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p50 = samples[Math.floor(samples.length * 0.5)] ?? samples[samples.length - 1]!;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1]!;
  const edges = [0, 15, 30, 45, 60, 90, 120, 180, 300, Infinity];
  const buckets: { range: string; count: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1]!;
    const count = samples.filter((s) => s >= lo && s < hi).length;
    const range = hi === Infinity ? `${lo}s+` : `${lo}–${hi}s`;
    buckets.push({ range, count });
  }
  return {
    samples: samples.length,
    min: samples[0]!,
    max: samples[samples.length - 1]!,
    mean,
    p50,
    p95,
    buckets,
  };
}

export interface ErrorBreakdown {
  reason: string;
  count: number;
}

/**
 * Group failed orders by sanitised error reason and return the top N
 * buckets. The backend already sanitises the reason strings so this
 * collapses into at most half a dozen categories.
 */
export function errorBreakdown(orders: Order[], top = 5): ErrorBreakdown[] {
  const counts = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== 'failed' && o.status !== 'refunded') continue;
    const reason = shortReason(o.error) || 'Unknown';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([reason, count]) => ({ reason, count }));
}

function shortReason(error: string | null): string {
  if (!error) return '';
  // Sanitised messages are long sentences — take the first clause
  // for a legible chart label.
  const firstPeriod = error.indexOf('.');
  return (firstPeriod > 0 ? error.slice(0, firstPeriod) : error).slice(0, 60);
}

export interface MarginSummary {
  revenue: number;
  estimatedCtxCost: number;
  estimatedMargin: number;
  marginPct: number;
  deliveredCount: number;
}

/**
 * CTX partner discount is 250 bips (2.5%) on the Visa eReward card,
 * so a $10 order costs us ~$9.75 to fulfil. This is a CLIENT-SIDE
 * ESTIMATE used by the analytics page for quick KPIs. The platform
 * margins page (/dashboard/platform/margins) uses real per-order
 * cost data captured at settlement time; this function is a fallback
 * for the lightweight analytics view.
 */
export function marginSummary(orders: Order[], discountPct = 2.5): MarginSummary {
  const delivered = orders.filter((o) => o.status === 'delivered');
  const revenue = delivered.reduce((s, o) => s + (parseFloat(o.amount_usdc) || 0), 0);
  const estimatedCtxCost = revenue * (1 - discountPct / 100);
  const estimatedMargin = revenue - estimatedCtxCost;
  const marginPct = revenue > 0 ? (estimatedMargin / revenue) * 100 : 0;
  return {
    revenue,
    estimatedCtxCost,
    estimatedMargin,
    marginPct,
    deliveredCount: delivered.length,
  };
}
