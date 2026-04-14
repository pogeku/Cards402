// Platform audit — cross-tenant audit log. Every sensitive action
// recorded by recordAudit() across every dashboard, with actor,
// resource, and details JSON.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformAudit, type PlatformAuditEntry } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

export default function PlatformAuditPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [rows, setRows] = useState<PlatformAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformAudit();
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
      <PageHeader title="Audit log" subtitle="Cross-tenant audit trail" />

      {error && (
        <Card title="Error">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      <Card title={`${rows?.length ?? 0} entries`} padding={0}>
        {rows === null ? (
          <EmptyState title="Loading…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No audit entries" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Dashboard</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(e.created_at)}
                  </td>
                  <td style={{ fontSize: '0.72rem' }}>{e.dashboard_name || '—'}</td>
                  <td>
                    <div style={{ fontSize: '0.7rem' }}>{e.actor_email}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--fg-dim)' }}>
                      {e.actor_role}
                    </div>
                  </td>
                  <td>
                    <Pill tone="neutral">{e.action}</Pill>
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.66rem',
                      color: 'var(--fg-muted)',
                    }}
                  >
                    {e.resource_type}
                    {e.resource_id ? ` · ${e.resource_id.slice(0, 8)}` : ''}
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.66rem',
                      color: 'var(--fg-muted)',
                    }}
                  >
                    {e.ip || '—'}
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
