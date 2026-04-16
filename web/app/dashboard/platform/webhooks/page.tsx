// Platform webhooks — cross-tenant delivery log + pending queue.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformWebhooks, type PlatformWebhooks } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

function statusTone(status: number | null): 'green' | 'yellow' | 'red' | 'neutral' {
  if (status === null) return 'red';
  if (status >= 200 && status < 300) return 'green';
  if (status >= 300 && status < 400) return 'yellow';
  return 'red';
}

export default function PlatformWebhooksPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [data, setData] = useState<PlatformWebhooks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformWebhooks();
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

  return (
    <PageContainer>
      <PageHeader title="Webhooks" subtitle="Cross-tenant delivery log + pending retry queue" />

      {error && (
        <Card title="Error">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      <Card title={`Recent deliveries (${data?.deliveries.length ?? 0})`} padding={0}>
        {data === null ? (
          <EmptyState title="Loading…" />
        ) : data.deliveries.length === 0 ? (
          <EmptyState title="No deliveries yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Dashboard / agent</th>
                <th>URL</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Latency</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(d.created_at)}
                  </td>
                  <td>
                    <div style={{ fontSize: '0.72rem' }}>{d.dashboard_name || '—'}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--fg-dim)' }}>
                      {d.api_key_label || '—'}
                    </div>
                  </td>
                  <td
                    style={{
                      fontSize: '0.66rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--fg-muted)',
                      maxWidth: 260,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={d.url}
                  >
                    {d.url}
                  </td>
                  <td>
                    <Pill tone={statusTone(d.response_status)}>{d.response_status ?? 'err'}</Pill>
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                    }}
                  >
                    {d.latency_ms ?? '—'}ms
                  </td>
                  <td
                    style={{
                      fontSize: '0.64rem',
                      color: 'var(--fg-dim)',
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={d.error || ''}
                  >
                    {d.error || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={`Pending retry queue (${data?.queue.length ?? 0})`} padding={0}>
        {data === null ? (
          <EmptyState title="Loading…" />
        ) : data.queue.length === 0 ? (
          <EmptyState title="Queue empty" description="No webhook deliveries waiting to retry." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>URL</th>
                <th>Attempts</th>
                <th>Next</th>
                <th>Delivered</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.queue.map((q) => (
                <tr key={q.id}>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(q.created_at)}
                  </td>
                  <td
                    style={{
                      fontSize: '0.66rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--fg-muted)',
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={q.url}
                  >
                    {q.url}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                    {q.attempts} / 4
                  </td>
                  <td style={{ fontSize: '0.66rem', color: 'var(--fg-dim)' }}>
                    {q.delivered ? '—' : timeAgo(q.next_attempt)}
                  </td>
                  <td>
                    <Pill tone={q.delivered ? 'green' : q.attempts > 3 ? 'red' : 'yellow'}>
                      {q.delivered ? 'yes' : q.attempts > 3 ? 'abandoned' : 'pending'}
                    </Pill>
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
                    title={q.last_error || ''}
                  >
                    {q.last_error || '—'}
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
