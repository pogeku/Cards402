// Platform unmatched payments — cross-tenant reconciliation queue.
// Every row here represents real on-chain funds that landed in the
// receiver contract but didn't match a valid pending order (wrong
// order id, underpayment, duplicate, etc). Ops needs to refund these
// manually from the treasury, or they sit as orphaned value forever.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformUnmatchedPayments, type PlatformUnmatchedPayment } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

export default function PlatformUnmatchedPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [rows, setRows] = useState<PlatformUnmatchedPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformUnmatchedPayments();
        if (!cancelled) setRows(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user?.is_platform_owner]);

  if (!user?.is_platform_owner) return null;

  const pending = rows?.filter((r) => !r.refund_stellar_txid).length ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="Unmatched payments"
        subtitle="On-chain payments the watcher saw but couldn't match to a valid order. Refund queue."
      />

      {error && (
        <Card title="Error">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      <Card
        title={rows === null ? 'Loading…' : `${rows.length} total · ${pending} awaiting refund`}
        padding={0}
      >
        {rows === null ? (
          <EmptyState title="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Queue empty"
            description="Every on-chain payment matched a valid order — no orphaned funds."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Asset</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Reason</th>
                <th>Sender</th>
                <th>Claimed order</th>
                <th>Refund</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(p.created_at)}
                  </td>
                  <td style={{ fontSize: '0.7rem' }}>{p.payment_asset || '—'}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {p.amount_usdc ?? p.amount_xlm ?? '—'}
                  </td>
                  <td>
                    <Pill tone="yellow">{p.reason}</Pill>
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.66rem',
                      color: 'var(--fg-muted)',
                    }}
                  >
                    {p.sender_address
                      ? `${p.sender_address.slice(0, 6)}…${p.sender_address.slice(-4)}`
                      : '—'}
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.66rem',
                      color: 'var(--fg-muted)',
                    }}
                  >
                    {p.claimed_order_id ? p.claimed_order_id.slice(0, 8) : '—'}
                  </td>
                  <td>
                    {p.refund_stellar_txid ? (
                      <Pill tone="green">refunded</Pill>
                    ) : (
                      <Pill tone="red">pending</Pill>
                    )}
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
