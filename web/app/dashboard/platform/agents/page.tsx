// Platform agents — every api_key across every dashboard.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformAgents, type PlatformAgent } from '../../_lib/api';
import { timeAgo, formatUsd } from '../../_lib/format';

export default function PlatformAgentsPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [rows, setRows] = useState<PlatformAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformAgents();
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

  return (
    <PageContainer>
      <PageHeader
        title="All agents"
        subtitle={`Every api_key across every dashboard${rows ? ` — ${rows.length} total` : ''}.`}
      />

      <Card title="Agents" padding={0}>
        {error ? (
          <div style={{ color: 'var(--red)', padding: '1rem', fontSize: '0.8rem' }}>{error}</div>
        ) : rows === null ? (
          <EmptyState title="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No agents" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Owner</th>
                <th>State</th>
                <th>Mode</th>
                <th style={{ textAlign: 'right' }}>Orders</th>
                <th style={{ textAlign: 'right' }}>Delivered</th>
                <th style={{ textAlign: 'right' }}>Refunded</th>
                <th style={{ textAlign: 'right' }}>Spent</th>
                <th>Last used</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{a.label || '—'}</div>
                    <div
                      style={{
                        fontSize: '0.64rem',
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {a.key_prefix || a.id.slice(0, 8)}
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: '0.72rem' }}>{a.dashboard_name || '—'}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--fg-dim)' }}>
                      {a.owner_email || '—'}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                      {a.suspended ? <Pill tone="red">suspended</Pill> : null}
                      {!a.enabled ? <Pill tone="neutral">disabled</Pill> : null}
                      {a.agent_state && <Pill tone="neutral">{a.agent_state}</Pill>}
                      {!a.suspended && a.enabled && !a.agent_state && (
                        <Pill tone="green">active</Pill>
                      )}
                    </div>
                  </td>
                  <td style={{ fontSize: '0.7rem', color: 'var(--fg-muted)' }}>{a.mode}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {a.order_count}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {a.delivered_count}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {a.refunded_count}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {formatUsd(parseFloat(a.total_spent_usdc || '0'))}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {a.last_used_at ? timeAgo(a.last_used_at) : '—'}
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
