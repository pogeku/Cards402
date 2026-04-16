// Platform margins — per-order revenue/cost/margin breakdown.
// Only uses real settlement data (ctx_invoice_xlm × settlement_xlm_usd_rate).
// Historical orders without settlement data show "no data" — no estimates.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../../_lib/DashboardProvider';
import { PageContainer } from '../../_ui/PageContainer';
import { PageHeader } from '../../_ui/PageHeader';
import { Card } from '../../_ui/Card';
import { KpiRow, KpiTile } from '../../_ui/KpiTile';
import { EmptyState } from '../../_ui/EmptyState';
import { fetchPlatformMargins, type PlatformMargins } from '../../_lib/api';
import { timeAgo, formatUsd } from '../../_lib/format';

const TH: React.CSSProperties = {
  padding: '0.6rem 0.75rem',
  fontSize: '0.68rem',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border)',
};

const TD: React.CSSProperties = {
  padding: '0.55rem 0.75rem',
  fontSize: '0.78rem',
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export default function PlatformMarginsPage() {
  const router = useRouter();
  const { user } = useDashboard();
  const [data, setData] = useState<PlatformMargins | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && !user.is_platform_owner) router.replace('/dashboard/overview');
  }, [user, router]);

  useEffect(() => {
    if (!user?.is_platform_owner) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchPlatformMargins(500);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.is_platform_owner]);

  if (!user?.is_platform_owner) return null;

  const s = data?.summary;

  return (
    <PageContainer>
      <PageHeader
        title="Margins"
        subtitle="Per-order revenue, cost of sale, and margin. Only orders with real settlement data are included in the totals."
      />

      {error && (
        <Card>
          <p style={{ color: 'var(--red)', padding: '1rem' }}>Error loading margins: {error}</p>
        </Card>
      )}

      {s && (
        <KpiRow>
          <KpiTile
            label="Revenue (all delivered)"
            value={formatUsd(s.total_revenue_usdc)}
            hint={`${s.delivered_count} orders`}
          />
          <KpiTile
            label="CTX Cost (settlement)"
            value={s.orders_with_cost_data > 0 ? formatUsd(s.total_ctx_cost_usd) : '—'}
            hint={
              s.orders_with_cost_data > 0
                ? `${s.orders_with_cost_data} orders with data`
                : 'no settlement data yet'
            }
          />
          <KpiTile
            label="Gross Margin"
            value={s.orders_with_cost_data > 0 ? formatUsd(s.total_margin_usd) : '—'}
            hint={s.margin_pct !== null ? `${s.margin_pct}% effective` : 'awaiting settlement data'}
          />
          <KpiTile
            label="Coverage"
            value={`${s.orders_with_cost_data} / ${s.delivered_count}`}
            hint={
              s.orders_without_cost_data > 0
                ? `${s.orders_without_cost_data} historical (no data)`
                : 'all orders have settlement data'
            }
          />
        </KpiRow>
      )}

      {data && data.orders.length === 0 && (
        <EmptyState
          title="No delivered orders yet"
          description="Margins appear here once orders are fulfilled. New orders automatically capture CTX settlement costs."
        />
      )}

      {data && data.orders.length > 0 && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={TH}>Order</th>
                  <th style={TH}>Date</th>
                  <th style={TH}>Agent</th>
                  <th style={TH}>Asset</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Revenue</th>
                  <th style={{ ...TH, textAlign: 'right' }}>CTX Invoice</th>
                  <th style={{ ...TH, textAlign: 'right' }}>XLM Rate</th>
                  <th style={{ ...TH, textAlign: 'right' }}>CTX Cost</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Margin</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Discount</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => {
                  const dim = { ...TD, color: 'var(--fg-dim)' };
                  const noData = !o.has_cost_data;
                  return (
                    <tr key={o.id} style={noData ? { opacity: 0.5 } : undefined}>
                      <td style={{ ...TD, fontSize: '0.72rem' }}>{o.id.slice(0, 8)}</td>
                      <td style={dim}>{timeAgo(o.created_at)}</td>
                      <td style={dim}>{o.api_key_label || '—'}</td>
                      <td style={{ ...TD, fontSize: '0.7rem' }}>
                        {o.payment_asset?.replace('_soroban', '') || '—'}
                      </td>
                      <td style={{ ...TD, textAlign: 'right' }}>
                        {formatUsd(parseFloat(o.amount_usdc))}
                      </td>
                      <td style={{ ...dim, textAlign: 'right' }}>
                        {o.ctx_invoice_xlm
                          ? `${parseFloat(o.ctx_invoice_xlm).toFixed(4)} XLM`
                          : '—'}
                      </td>
                      <td style={{ ...dim, textAlign: 'right' }}>
                        {o.settlement_xlm_usd_rate
                          ? `$${parseFloat(o.settlement_xlm_usd_rate).toFixed(4)}`
                          : '—'}
                      </td>
                      <td style={{ ...dim, textAlign: 'right' }}>
                        {o.ctx_cost_usd ? formatUsd(parseFloat(o.ctx_cost_usd)) : '—'}
                      </td>
                      <td
                        style={{
                          ...TD,
                          textAlign: 'right',
                          color: o.has_cost_data
                            ? parseFloat(o.margin_usd || '0') > 0
                              ? 'var(--green)'
                              : 'var(--red)'
                            : 'var(--fg-dim)',
                        }}
                      >
                        {o.margin_usd ? formatUsd(parseFloat(o.margin_usd)) : '—'}
                      </td>
                      <td style={{ ...dim, textAlign: 'right' }}>
                        {o.effective_discount_pct ? `${o.effective_discount_pct}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {s && s.orders_without_cost_data > 0 && (
            <div
              style={{
                padding: '0.75rem',
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--fg-dim)',
                borderTop: '1px solid var(--border)',
              }}
            >
              {s.orders_without_cost_data} historical order(s) have no settlement data (dimmed
              rows). New orders automatically capture CTX invoice amounts and XLM rates at payment
              time.
            </div>
          )}
        </Card>
      )}
    </PageContainer>
  );
}
