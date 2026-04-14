// Platform orders — cross-tenant orders table. Hits
// /dashboard/platform/orders which joins api_keys → dashboards → users,
// so each row carries its owning agent label + dashboard + owner email.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { EmptyState } from '../../_ui/EmptyState';
import { OrderStatusPill } from '../../_ui/OrderStatusPill';
import { fetchPlatformOrders, type PlatformOrder } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

const STATUS_OPTIONS = [
  '',
  'pending_payment',
  'awaiting_approval',
  'ordering',
  'delivered',
  'failed',
  'refund_pending',
  'refunded',
  'expired',
  'rejected',
];

export default function PlatformOrdersPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [rows, setRows] = useState<PlatformOrder[] | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformOrders({ status: status || undefined, limit: 200 });
        if (!cancelled) setRows(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user?.is_platform_owner, status]);

  if (!user?.is_platform_owner) return null;

  return (
    <PageContainer>
      <PageHeader title="All orders" subtitle="Every order across every dashboard. Read-only." />

      <Card
        title={rows ? `Showing ${rows.length} orders` : 'Loading…'}
        actions={
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={{
              padding: '0.3rem 0.5rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--fg)',
              fontSize: '0.72rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s || 'all statuses'}
              </option>
            ))}
          </select>
        }
        padding={0}
      >
        {error ? (
          <div style={{ color: 'var(--red)', padding: '1rem', fontSize: '0.8rem' }}>{error}</div>
        ) : rows === null ? (
          <EmptyState title="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No orders match the filter" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Order</th>
                <th>Dashboard / Agent</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Asset</th>
                <th>Brand</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(o.created_at)}
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.68rem',
                    }}
                  >
                    {o.id.slice(0, 8)}
                  </td>
                  <td>
                    <div style={{ fontSize: '0.74rem' }}>{o.dashboard_name || '—'}</div>
                    <div style={{ fontSize: '0.64rem', color: 'var(--fg-dim)' }}>
                      {o.api_key_label || '—'} · {o.owner_email || '—'}
                    </div>
                  </td>
                  <td>
                    <OrderStatusPill status={o.status} />
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    ${parseFloat(o.amount_usdc).toFixed(2)}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-muted)' }}>
                    {o.payment_asset || '—'}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-muted)' }}>
                    {o.card_brand || '—'}
                  </td>
                  <td
                    style={{
                      fontSize: '0.64rem',
                      color: 'var(--fg-dim)',
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={o.error || ''}
                  >
                    {o.error || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </PageContainer>
  );
}
