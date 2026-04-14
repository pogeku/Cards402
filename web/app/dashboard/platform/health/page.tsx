// Platform health — watcher freshness, circuit breaker, dead-letter
// queue, webhook backlog, unmatched payments. Includes the unfreeze
// action so the operator can reset the circuit breaker without SSHing.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { KpiRow, KpiTile } from '../../_ui/KpiTile';
import { Pill } from '../../_ui/Pill';
import { Button } from '../../_ui/Button';
import { EmptyState } from '../../_ui/EmptyState';
import { useToast } from '../../_ui/Toast';
import { fetchPlatformHealth, postPlatformUnfreeze, type PlatformHealth } from '../../_lib/api';
import { timeAgo } from '../../_lib/format';

export default function PlatformHealthPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const toast = useToast();
  const [data, setData] = useState<PlatformHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unfreezing, setUnfreezing] = useState(false);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  const load = async () => {
    try {
      const result = await fetchPlatformHealth();
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [user?.is_platform_owner]);

  async function handleUnfreeze() {
    if (
      !confirm(
        'Clear the frozen flag and reset consecutive_failures to 0? This will let order fulfillment resume.',
      )
    ) {
      return;
    }
    setUnfreezing(true);
    try {
      const result = await postPlatformUnfreeze();
      toast.push(result.frozen === false ? 'Platform unfrozen' : 'Unfreeze failed', 'success');
      await load();
    } catch (err) {
      toast.push((err as Error).message || 'unfreeze failed', 'error');
    } finally {
      setUnfreezing(false);
    }
  }

  if (!user?.is_platform_owner) return null;

  return (
    <PageContainer>
      <PageHeader
        title="Health"
        subtitle="Watcher, circuit breaker, dead-letter queue, webhook backlog"
      />

      {error && (
        <Card title="Error loading health">
          <div style={{ color: 'var(--red)', fontSize: '0.8rem' }}>{error}</div>
        </Card>
      )}

      {data && (
        <>
          {/* Top KPIs */}
          <KpiRow>
            <KpiTile
              label="Watcher age"
              value={data.watcher.age_seconds !== null ? `${data.watcher.age_seconds}s` : '—'}
              hint={data.watcher.last_ledger ? `ledger ${data.watcher.last_ledger}` : undefined}
            />
            <KpiTile
              label="Frozen"
              value={data.circuit_breaker.frozen ? 'YES' : 'no'}
              hint={`${data.circuit_breaker.consecutive_failures} / 3 breaker`}
            />
            <KpiTile
              label="Dead letter (24h)"
              value={data.dead_letter.last_24h}
              hint={`${data.dead_letter.total} all time`}
            />
            <KpiTile
              label="Webhook backlog"
              value={data.webhook_backlog.pending}
              hint={`${data.webhook_backlog.failed_permanent_24h} abandoned`}
            />
          </KpiRow>

          {/* Circuit breaker control */}
          <Card
            title="Circuit breaker"
            actions={
              data.circuit_breaker.frozen || data.circuit_breaker.consecutive_failures > 0 ? (
                <Button variant="primary" onClick={handleUnfreeze} disabled={unfreezing}>
                  {unfreezing ? 'Unfreezing…' : 'Unfreeze + reset'}
                </Button>
              ) : undefined
            }
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '0.4rem 1.25rem',
                fontSize: '0.78rem',
              }}
            >
              <div style={{ color: 'var(--fg-dim)' }}>Frozen</div>
              <div>
                <Pill tone={data.circuit_breaker.frozen ? 'red' : 'green'}>
                  {data.circuit_breaker.frozen ? 'YES — orders paused' : 'no'}
                </Pill>
              </div>
              <div style={{ color: 'var(--fg-dim)' }}>Consecutive failures</div>
              <div style={{ fontFamily: 'var(--font-mono)' }}>
                {data.circuit_breaker.consecutive_failures} / 3
              </div>
              <div style={{ color: 'var(--fg-dim)' }}>Unmatched payments</div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: data.unmatched_payments > 0 ? 'var(--yellow)' : 'var(--fg)',
                }}
              >
                {data.unmatched_payments}
              </div>
            </div>
          </Card>

          {/* Watcher */}
          <Card title="Stellar payment watcher">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '0.4rem 1.25rem',
                fontSize: '0.78rem',
              }}
            >
              <div style={{ color: 'var(--fg-dim)' }}>Status</div>
              <div>
                <Pill tone={data.watcher.healthy ? 'green' : 'yellow'}>
                  {data.watcher.healthy ? 'healthy' : 'degraded or stalled'}
                </Pill>
              </div>
              <div style={{ color: 'var(--fg-dim)' }}>Last ledger</div>
              <div style={{ fontFamily: 'var(--font-mono)' }}>
                {data.watcher.last_ledger ?? '—'}
              </div>
              <div style={{ color: 'var(--fg-dim)' }}>Last advance</div>
              <div style={{ fontFamily: 'var(--font-mono)' }}>
                {data.watcher.last_ledger_at
                  ? `${timeAgo(data.watcher.last_ledger_at)} (${data.watcher.age_seconds}s)`
                  : '—'}
              </div>
            </div>
          </Card>

          {/* Dead letter */}
          <Card title={`Dead letter (${data.dead_letter.total} total)`} padding={0}>
            {data.dead_letter.recent.length === 0 ? (
              <EmptyState
                title="Empty dead letter queue"
                description="Every on-chain event the watcher has seen has been parsed cleanly."
              />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Ledger</th>
                    <th>Tx</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dead_letter.recent.map((r) => (
                    <tr key={r.tx_hash}>
                      <td style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
                        {timeAgo(r.created_at)}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                        {r.ledger}
                      </td>
                      <td>
                        <a
                          href={`https://stellar.expert/explorer/public/tx/${r.tx_hash}`}
                          target="_blank"
                          rel="noopener"
                          style={{ fontFamily: 'var(--font-mono)', fontSize: '0.66rem' }}
                        >
                          {r.tx_hash.slice(0, 10)}…
                        </a>
                      </td>
                      <td
                        style={{
                          fontSize: '0.66rem',
                          color: 'var(--fg-dim)',
                          maxWidth: 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={r.error}
                      >
                        {r.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Webhook backlog */}
          <Card title="Webhook backlog">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '0.4rem 1.25rem',
                fontSize: '0.78rem',
              }}
            >
              <div style={{ color: 'var(--fg-dim)' }}>Pending (retrying)</div>
              <div style={{ fontFamily: 'var(--font-mono)' }}>{data.webhook_backlog.pending}</div>
              <div style={{ color: 'var(--fg-dim)' }}>Abandoned (24h)</div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  color:
                    data.webhook_backlog.failed_permanent_24h > 0 ? 'var(--yellow)' : 'var(--fg)',
                }}
              >
                {data.webhook_backlog.failed_permanent_24h}
              </div>
              <div style={{ color: 'var(--fg-dim)' }}>Total deliveries (24h)</div>
              <div style={{ fontFamily: 'var(--font-mono)' }}>
                {data.webhook_backlog.total_deliveries_24h}
              </div>
              <div style={{ color: 'var(--fg-dim)' }}>Failed deliveries (24h)</div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  color:
                    data.webhook_backlog.failed_deliveries_24h > 0 ? 'var(--yellow)' : 'var(--fg)',
                }}
              >
                {data.webhook_backlog.failed_deliveries_24h}
              </div>
            </div>
          </Card>
        </>
      )}
    </PageContainer>
  );
}
