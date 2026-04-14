// Platform overview — cross-tenant cockpit for the deployment owner.
// Aggregates every signal you'd want at a glance: totals, 24h volume,
// treasury, watcher health, top spenders, pending queues.
//
// Gated on the client by redirecting non-owners back to /dashboard;
// the backend will also 403 any fetch so there's no data leak even
// if the redirect is skipped.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useDashboard } from '../_lib/DashboardProvider';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { KpiTile, KpiRow } from '../_ui/KpiTile';
import { Card } from '../_ui/Card';
import { Pill } from '../_ui/Pill';
import { EmptyState } from '../_ui/EmptyState';
import { fetchPlatformOverview, type PlatformOverview } from '../_lib/api';
import { formatUsd, timeAgo } from '../_lib/format';

export default function PlatformOverviewPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Platform-owner gate. Non-owners get bounced back to the regular
  // dashboard so the section is effectively invisible.
  useEffect(() => {
    if (user && !user.is_platform_owner) {
      router.replace('/dashboard/overview');
    }
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformOverview();
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user?.is_platform_owner]);

  if (!user?.is_platform_owner) return null;

  if (error) {
    return (
      <PageContainer>
        <PageHeader title="Platform" subtitle="Cross-tenant operator view" />
        <Card title="Error loading overview">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      </PageContainer>
    );
  }

  if (!data) {
    return (
      <PageContainer>
        <PageHeader title="Platform" subtitle="Cross-tenant operator view" />
        <Card title="Loading…">
          <div style={{ color: 'var(--fg-dim)', fontSize: '0.8rem' }}>Fetching platform state…</div>
        </Card>
      </PageContainer>
    );
  }

  const successPct =
    data.last_24h.success_rate !== null ? (data.last_24h.success_rate * 100).toFixed(1) : 'n/a';
  const watcherHealthy = data.watcher.age_seconds !== null && data.watcher.age_seconds < 60;

  return (
    <PageContainer>
      <PageHeader
        title="Platform"
        subtitle={`Cross-tenant view — ${data.counts.dashboards} dashboards, ${data.counts.users} users, ${data.counts.api_keys} agents`}
      />

      {/* Top KPI row */}
      <KpiRow>
        <KpiTile label="Dashboards" value={data.counts.dashboards} />
        <KpiTile label="Users" value={data.counts.users} />
        <KpiTile
          label="Agents"
          value={data.counts.api_keys}
          hint={`${data.counts.active_agents} active`}
        />
        <KpiTile label="Orders" value={data.counts.orders} />
      </KpiRow>

      {/* 24h stats */}
      <KpiRow>
        <KpiTile label="24h volume" value={`$${data.last_24h.delivered_volume_usd}`} />
        <KpiTile
          label="24h orders"
          value={data.last_24h.total}
          hint={`${data.last_24h.delivered} delivered · ${data.last_24h.refunded} refunded`}
        />
        <KpiTile label="24h success" value={`${successPct}%`} />
        <KpiTile
          label="Treasury XLM"
          value={data.treasury.xlm !== null ? parseFloat(data.treasury.xlm).toFixed(2) : '—'}
          hint={
            data.treasury.usdc !== null
              ? `${parseFloat(data.treasury.usdc).toFixed(2)} USDC`
              : undefined
          }
        />
      </KpiRow>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)',
          gap: '1.25rem',
        }}
      >
        {/* Top spenders */}
        <Card title="Top agents by lifetime spend">
          {data.top_agents.length === 0 ? (
            <EmptyState title="No agents yet" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Owner</th>
                  <th style={{ textAlign: 'right' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Lifetime spend</th>
                </tr>
              </thead>
              <tbody>
                {data.top_agents.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{a.label || '—'}</div>
                      <div style={{ fontSize: '0.66rem', color: 'var(--fg-dim)' }}>
                        {a.dashboard_name || '—'}
                      </div>
                    </td>
                    <td style={{ fontSize: '0.7rem', color: 'var(--fg-muted)' }}>
                      {a.owner_email || '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                      {a.order_count}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                      {formatUsd(parseFloat(a.total_spent_usdc || '0'))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* System status column */}
        <Card title="System">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            <StatusRow
              label="Frozen"
              tone={data.system.frozen ? 'red' : 'green'}
              value={data.system.frozen ? 'YES' : 'no'}
            />
            <StatusRow
              label="Circuit breaker"
              tone={
                data.system.consecutive_failures >= 3
                  ? 'red'
                  : data.system.consecutive_failures > 0
                    ? 'yellow'
                    : 'green'
              }
              value={`${data.system.consecutive_failures} / 3`}
            />
            <StatusRow
              label="Watcher"
              tone={watcherHealthy ? 'green' : 'yellow'}
              value={
                data.watcher.age_seconds !== null ? `${data.watcher.age_seconds}s ago` : 'unknown'
              }
              hint={data.watcher.last_ledger ? `ledger ${data.watcher.last_ledger}` : undefined}
            />
            <StatusRow
              label="Dead-letter (24h)"
              tone={data.watcher.dead_letter_24h > 0 ? 'yellow' : 'green'}
              value={String(data.watcher.dead_letter_24h)}
            />
            <StatusRow
              label="Webhook queue pending"
              tone={data.system.webhook_queue_pending > 5 ? 'yellow' : 'green'}
              value={String(data.system.webhook_queue_pending)}
            />
            <StatusRow
              label="Webhooks failed perm (24h)"
              tone={data.system.webhooks_failed_permanent_24h > 0 ? 'yellow' : 'green'}
              value={String(data.system.webhooks_failed_permanent_24h)}
            />
            <StatusRow
              label="Approvals pending"
              tone={data.system.approvals_pending > 0 ? 'yellow' : 'green'}
              value={String(data.system.approvals_pending)}
            />
            <StatusRow
              label="Unmatched payments"
              tone={data.system.unmatched_payments > 0 ? 'yellow' : 'green'}
              value={String(data.system.unmatched_payments)}
            />
          </div>
        </Card>
      </div>

      {/* Status breakdown */}
      <Card title="Order status breakdown">
        {data.status_counts.length === 0 ? (
          <EmptyState title="No orders yet" />
        ) : (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            {data.status_counts.map((s) => (
              <Pill key={s.status} tone="neutral">
                {s.status}: {s.n}
              </Pill>
            ))}
          </div>
        )}
      </Card>

      {/* Treasury snapshot */}
      <Card title="Treasury">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '0.5rem 1.25rem',
            fontSize: '0.78rem',
          }}
        >
          <div style={{ color: 'var(--fg-dim)' }}>Public key</div>
          <div style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
            {data.treasury.public_key || '—'}
          </div>
          <div style={{ color: 'var(--fg-dim)' }}>XLM</div>
          <div style={{ fontFamily: 'var(--font-mono)' }}>
            {data.treasury.xlm !== null ? parseFloat(data.treasury.xlm).toFixed(7) : '—'}
          </div>
          <div style={{ color: 'var(--fg-dim)' }}>USDC</div>
          <div style={{ fontFamily: 'var(--font-mono)' }}>
            {data.treasury.usdc !== null ? parseFloat(data.treasury.usdc).toFixed(7) : '—'}
          </div>
          {data.treasury.error && (
            <>
              <div style={{ color: 'var(--red)' }}>Error</div>
              <div style={{ color: 'var(--red)', fontSize: '0.72rem' }}>{data.treasury.error}</div>
            </>
          )}
        </div>
        <div style={{ marginTop: '0.8rem' }}>
          <Link href="/dashboard/platform/treasury" style={{ fontSize: '0.72rem' }}>
            View treasury outflows →
          </Link>
        </div>
      </Card>

      <div style={{ color: 'var(--fg-dim)', fontSize: '0.68rem', textAlign: 'right' }}>
        Updated {timeAgo(data.generated_at)} · auto-refresh 15s
      </div>
    </PageContainer>
  );
}

function StatusRow({
  label,
  tone,
  value,
  hint,
}: {
  label: string;
  tone: 'green' | 'yellow' | 'red';
  value: string;
  hint?: string;
}) {
  const color =
    tone === 'red' ? 'var(--red)' : tone === 'yellow' ? 'var(--yellow)' : 'var(--green)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem',
      }}
    >
      <div style={{ fontSize: '0.72rem', color: 'var(--fg-muted)' }}>{label}</div>
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.15rem' }}
      >
        <div style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)', color }}>{value}</div>
        {hint && <div style={{ fontSize: '0.62rem', color: 'var(--fg-dim)' }}>{hint}</div>}
      </div>
    </div>
  );
}
