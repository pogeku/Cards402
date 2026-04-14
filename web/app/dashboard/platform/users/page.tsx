// Platform users — every authenticated operator across every dashboard.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { EmptyState } from '../../_ui/EmptyState';
import {
  fetchPlatformUsers,
  fetchPlatformDashboards,
  type PlatformUser,
  type PlatformDashboard,
} from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

export default function PlatformUsersPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [users, setUsers] = useState<PlatformUser[] | null>(null);
  const [dashboards, setDashboards] = useState<PlatformDashboard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [u, d] = await Promise.all([fetchPlatformUsers(), fetchPlatformDashboards()]);
        if (!cancelled) {
          setUsers(u);
          setDashboards(d);
        }
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
      <PageHeader title="All users" subtitle="Every authenticated operator and their dashboard" />

      {error && (
        <Card title="Error">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      <Card title={`Users (${users?.length ?? 0})`} padding={0}>
        {users === null ? (
          <EmptyState title="Loading…" />
        ) : users.length === 0 ? (
          <EmptyState title="No users" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Dashboard</th>
                <th style={{ textAlign: 'right' }}>Agents</th>
                <th style={{ textAlign: 'right' }}>Orders</th>
                <th>Sessions</th>
                <th>Joined</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 500 }}>{u.email}</td>
                  <td>
                    <Pill tone={u.role === 'owner' ? 'green' : 'neutral'}>{u.role}</Pill>
                  </td>
                  <td style={{ fontSize: '0.72rem', color: 'var(--fg-muted)' }}>
                    {u.dashboard_name || '—'}
                    {u.dashboard_frozen ? (
                      <span style={{ marginLeft: '0.4rem' }}>
                        <Pill tone="red">frozen</Pill>
                      </span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {u.agent_count}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {u.order_count}
                  </td>
                  <td style={{ fontSize: '0.68rem' }}>
                    {u.active_sessions > 0 ? (
                      <Pill tone="green">{u.active_sessions} active</Pill>
                    ) : (
                      <span style={{ color: 'var(--fg-dim)' }}>—</span>
                    )}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(u.created_at)}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {u.last_login_at ? timeAgo(u.last_login_at) : 'never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={`Dashboards (${dashboards?.length ?? 0})`} padding={0}>
        {dashboards === null ? (
          <EmptyState title="Loading…" />
        ) : dashboards.length === 0 ? (
          <EmptyState title="No dashboards" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th style={{ textAlign: 'right' }}>Agents</th>
                <th style={{ textAlign: 'right' }}>Orders (24h)</th>
                <th style={{ textAlign: 'right' }}>Orders total</th>
                <th style={{ textAlign: 'right' }}>Delivered volume</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {dashboards.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{d.name}</div>
                    <div
                      style={{
                        fontSize: '0.62rem',
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {d.id.slice(0, 8)}
                    </div>
                  </td>
                  <td style={{ fontSize: '0.72rem' }}>
                    {d.owner_email || '—'}
                    {d.frozen ? (
                      <span style={{ marginLeft: '0.4rem' }}>
                        <Pill tone="red">frozen</Pill>
                      </span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {d.agent_count}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {d.orders_24h}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    {d.order_count}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    ${Number(d.delivered_volume_usd || 0).toFixed(2)}
                  </td>
                  <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                    {timeAgo(d.created_at)}
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
