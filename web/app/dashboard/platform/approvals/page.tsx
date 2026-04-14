// Platform approvals — every approval_request across every dashboard.
// Read-only from here; the actual approve/reject actions still live on
// the tenant-scoped /dashboard/approvals page where the operator can
// decide within their own dashboard context.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformApprovals, type PlatformApproval } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

function statusTone(status: string): 'green' | 'yellow' | 'red' | 'neutral' {
  if (status === 'approved') return 'green';
  if (status === 'pending') return 'yellow';
  if (status === 'rejected' || status === 'expired') return 'red';
  return 'neutral';
}

export default function PlatformApprovalsPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [rows, setRows] = useState<PlatformApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformApprovals();
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
  }, [user?.is_platform_owner]);

  if (!user?.is_platform_owner) return null;

  return (
    <PageContainer>
      <PageHeader
        title="All approvals"
        subtitle="Every approval_request across every dashboard. Decide actions live on each tenant's own approvals page."
      />

      {error && (
        <Card title="Error">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      <Card title={`Approvals (${rows?.length ?? 0})`} padding={0}>
        {rows === null ? (
          <EmptyState title="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No approvals" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Dashboard / Agent</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Status</th>
                <th>Decided by</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(a.requested_at)}
                  </td>
                  <td>
                    <div style={{ fontSize: '0.72rem' }}>{a.dashboard_name || '—'}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--fg-dim)' }}>
                      {a.api_key_label || '—'} · {a.owner_email || '—'}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    ${parseFloat(a.amount_usdc).toFixed(2)}
                  </td>
                  <td>
                    <Pill tone={statusTone(a.status)}>{a.status}</Pill>
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-muted)' }}>
                    {a.decided_by || '—'}
                  </td>
                  <td
                    style={{
                      fontSize: '0.64rem',
                      color: 'var(--fg-dim)',
                      maxWidth: 260,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={a.decision_note || a.agent_note || ''}
                  >
                    {a.decision_note || a.agent_note || '—'}
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
