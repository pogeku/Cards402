// Platform treasury — live Horizon balances + recent outflows.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { KpiRow, KpiTile } from '../../_ui/KpiTile';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformTreasury, type PlatformTreasury } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

export default function PlatformTreasuryPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [data, setData] = useState<PlatformTreasury | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformTreasury();
        if (!cancelled) setData(result);
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
      <PageHeader title="Treasury" subtitle="Live balance + recent on-chain outflows" />

      {error && (
        <Card title="Error">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      {data && (
        <>
          <KpiRow>
            <KpiTile
              label="XLM"
              value={data.balance.xlm !== null ? parseFloat(data.balance.xlm).toFixed(4) : '—'}
            />
            <KpiTile
              label="USDC"
              value={data.balance.usdc !== null ? parseFloat(data.balance.usdc).toFixed(4) : '—'}
            />
            <KpiTile label="Network" value={process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'mainnet'} />
            <KpiTile label="Recent outflows" value={data.outflows.length} />
          </KpiRow>

          <Card title="Public key">
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
                wordBreak: 'break-all',
                color: 'var(--fg)',
              }}
            >
              {data.balance.public_key || '—'}
            </div>
            {data.balance.public_key && (
              <div style={{ marginTop: '0.6rem', display: 'flex', gap: '0.5rem' }}>
                <a
                  href={`https://stellar.expert/explorer/public/account/${data.balance.public_key}`}
                  target="_blank"
                  rel="noopener"
                  style={{ fontSize: '0.72rem' }}
                >
                  stellar.expert ↗
                </a>
              </div>
            )}
            {data.balance.error && (
              <div style={{ color: 'var(--red)', fontSize: '0.72rem', marginTop: '0.4rem' }}>
                Horizon error: {data.balance.error}
              </div>
            )}
          </Card>

          <Card title={`Recent outflows (${data.outflows.length})`} padding={0}>
            {data.outflows.length === 0 ? (
              <EmptyState
                title="No recent outflows"
                description="Horizon returned no outgoing payments for this account."
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Asset</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Destination</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {data.outflows.map((o) => (
                    <tr key={o.tx_hash + o.amount}>
                      <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                        {timeAgo(o.created_at)}
                      </td>
                      <td style={{ fontSize: '0.72rem' }}>{o.asset_code}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                        {parseFloat(o.amount).toFixed(4)}
                      </td>
                      <td
                        style={{
                          fontSize: '0.66rem',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--fg-muted)',
                        }}
                      >
                        {o.to.slice(0, 6)}…{o.to.slice(-4)}
                      </td>
                      <td style={{ fontSize: '0.66rem' }}>
                        <a
                          href={`https://stellar.expert/explorer/public/tx/${o.tx_hash}`}
                          target="_blank"
                          rel="noopener"
                          style={{ fontFamily: 'var(--font-mono)' }}
                        >
                          {o.tx_hash.slice(0, 10)}…
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </PageContainer>
  );
}
