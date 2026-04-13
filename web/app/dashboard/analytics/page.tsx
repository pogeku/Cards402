// Analytics — derived views over the orders + agents arrays already
// cached in DashboardProvider. No extra round trips; everything on
// this page is a pure aggregation.

'use client';

import { useMemo, useState } from 'react';
import { useDashboard } from '../_lib/DashboardProvider';
import { Card } from '../_ui/Card';
import { KpiRow, KpiTile } from '../_ui/KpiTile';
import { SpendChart } from '../_ui/SpendChart';
import { HorizontalBar } from '../_ui/HorizontalBar';
import { FilterChip } from '../_ui/FilterChip';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { EmptyState } from '../_ui/EmptyState';
import { formatUsd, bucketSpendByDay } from '../_lib/format';
import { spendByAgent, latencyStats, errorBreakdown, marginSummary } from '../_lib/analytics';

const WINDOWS: Record<string, { label: string; days: number }> = {
  '24h': { label: '24 hours', days: 1 },
  '7d': { label: '7 days', days: 7 },
  '30d': { label: '30 days', days: 30 },
};

export default function AnalyticsPage() {
  const { user, orders, agents } = useDashboard();
  const isPlatformOwner = !!user?.is_platform_owner;
  const [windowKey, setWindowKey] = useState<'24h' | '7d' | '30d'>('7d');
  const windowDays = WINDOWS[windowKey]!.days;
  const windowMs = windowDays * 86_400_000;

  const windowOrders = useMemo(
    () => orders.filter((o) => Date.now() - Date.parse(o.created_at) < windowMs),
    [orders, windowMs],
  );

  const agentSpend = useMemo(
    () => spendByAgent(orders, agents, windowMs),
    [orders, agents, windowMs],
  );
  const latency = useMemo(() => latencyStats(windowOrders), [windowOrders]);
  const errors = useMemo(() => errorBreakdown(windowOrders), [windowOrders]);
  const margin = useMemo(() => marginSummary(windowOrders), [windowOrders]);
  const chartData = useMemo(() => bucketSpendByDay(orders, windowDays), [orders, windowDays]);

  return (
    <PageContainer>
      <PageHeader
        title="Analytics"
        subtitle={
          isPlatformOwner
            ? 'Spend, latency, error mix, and margin over the selected window.'
            : 'Spend, latency, and error mix over the selected window.'
        }
        actions={
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {(['24h', '7d', '30d'] as const).map((w) => (
              <FilterChip key={w} active={windowKey === w} onClick={() => setWindowKey(w)}>
                {WINDOWS[w]!.label}
              </FilterChip>
            ))}
          </div>
        }
      />

      {windowOrders.length === 0 ? (
        <Card>
          <EmptyState
            title="No data for this window"
            description="Pick a longer window or run a purchase — charts will populate from live orders."
          />
        </Card>
      ) : (
        <>
          <KpiRow>
            <KpiTile
              label="Spend"
              value={formatUsd(margin.revenue)}
              hint={`${margin.deliveredCount} delivered`}
            />
            {/* CTX cost + gross margin are operator P&L — only surface
                them to the platform owner. Regular users see their own
                spend and latency but not the fulfillment economics. */}
            {isPlatformOwner && (
              <>
                <KpiTile
                  label="Est. cost"
                  value={formatUsd(margin.estimatedCtxCost)}
                  hint="merchant discount"
                />
                <KpiTile
                  label="Est. margin"
                  value={formatUsd(margin.estimatedMargin)}
                  hint={`${margin.marginPct.toFixed(1)}% gross`}
                  delta={{
                    value: `${margin.marginPct.toFixed(1)}%`,
                    positive: margin.marginPct > 0,
                  }}
                />
              </>
            )}
            <KpiTile
              label="Delivered"
              value={margin.deliveredCount}
              hint={windowOrders.length > 0 ? `of ${windowOrders.length} attempts` : 'no attempts'}
            />
            <KpiTile
              label="Latency p50 / p95"
              value={
                latency.samples > 0
                  ? `${latency.p50.toFixed(0)}s / ${latency.p95.toFixed(0)}s`
                  : '—'
              }
              hint={latency.samples > 0 ? `${latency.samples} samples` : 'no deliveries'}
            />
          </KpiRow>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
              gap: '1.25rem',
            }}
          >
            <Card title="Spend over time">
              <SpendChart data={chartData} height={220} />
            </Card>
            <Card title="Latency distribution">
              <HorizontalBar
                rows={latency.buckets.map((b) => ({
                  label: b.range,
                  value: b.count,
                  trailing: b.count,
                }))}
              />
              <div
                style={{
                  marginTop: '0.8rem',
                  fontSize: '0.68rem',
                  color: 'var(--fg-dim)',
                }}
              >
                min {latency.min.toFixed(0)}s · mean {latency.mean.toFixed(0)}s · max{' '}
                {latency.max.toFixed(0)}s
              </div>
            </Card>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
              gap: '1.25rem',
            }}
          >
            <Card title="Spend by agent">
              <HorizontalBar
                rows={agentSpend.slice(0, 10).map((a) => ({
                  label: a.label,
                  value: a.amount,
                  trailing: `${formatUsd(a.amount)} · ${a.count} orders`,
                }))}
              />
            </Card>
            <Card title="Failure breakdown">
              {errors.length === 0 ? (
                <EmptyState title="No failures in this window" />
              ) : (
                <HorizontalBar
                  rows={errors.map((e) => ({
                    label: e.reason,
                    value: e.count,
                    trailing: `${e.count} orders`,
                  }))}
                />
              )}
            </Card>
          </div>
        </>
      )}
    </PageContainer>
  );
}
