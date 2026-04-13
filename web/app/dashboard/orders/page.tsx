// Orders — fleet-wide order history with filters, presets, and a
// detail drawer that shows the full lifecycle for one order.

'use client';

import { useMemo, useState } from 'react';
import { useDashboard } from '../_lib/DashboardProvider';
import { Card } from '../_ui/Card';
import { Input } from '../_ui/Input';
import { EmptyState } from '../_ui/EmptyState';
import { Drawer } from '../_ui/Drawer';
import { OrderStatusPill } from '../_ui/OrderStatusPill';
import { FilterChip } from '../_ui/FilterChip';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { formatUsd, timeAgo } from '../_lib/format';
import { IN_FLIGHT_ORDER_STATUSES } from '../_lib/constants';
import type { Order } from '../_lib/types';

type Preset = 'all' | 'failed_today' | 'in_flight' | 'delivered_7d' | 'refunded';

export default function OrdersPage() {
  const { orders, agents } = useDashboard();
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<Preset>('all');
  const [selected, setSelected] = useState<Order | null>(null);

  const filtered = useMemo(() => {
    const now = Date.now();
    const DAY = 86_400_000;
    let list = orders;
    switch (preset) {
      case 'failed_today':
        list = list.filter((o) => o.status === 'failed' && now - Date.parse(o.created_at) < DAY);
        break;
      case 'in_flight':
        list = list.filter((o) => IN_FLIGHT_ORDER_STATUSES.has(o.status));
        break;
      case 'delivered_7d':
        list = list.filter(
          (o) => o.status === 'delivered' && now - Date.parse(o.created_at) < 7 * DAY,
        );
        break;
      case 'refunded':
        list = list.filter((o) => o.status === 'refunded' || o.status === 'refund_pending');
        break;
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((o) => {
        return (
          o.id.toLowerCase().includes(q) ||
          (o.api_key_label || '').toLowerCase().includes(q) ||
          (o.stellar_txid || '').toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [orders, query, preset]);

  const counts = useMemo(() => {
    const now = Date.now();
    const DAY = 86_400_000;
    return {
      all: orders.length,
      failed_today: orders.filter(
        (o) => o.status === 'failed' && now - Date.parse(o.created_at) < DAY,
      ).length,
      in_flight: orders.filter((o) => IN_FLIGHT_ORDER_STATUSES.has(o.status)).length,
      delivered_7d: orders.filter(
        (o) => o.status === 'delivered' && now - Date.parse(o.created_at) < 7 * DAY,
      ).length,
      refunded: orders.filter((o) => o.status === 'refunded' || o.status === 'refund_pending')
        .length,
    };
  }, [orders]);

  return (
    <PageContainer>
      <PageHeader
        title="Orders"
        subtitle={`${orders.length} total — ${counts.in_flight} in flight, ${counts.failed_today} failed today`}
      />

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, maxWidth: 340 }}>
          <Input
            placeholder="Search by order id, agent, txid…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <FilterChip active={preset === 'all'} onClick={() => setPreset('all')} count={counts.all}>
          All
        </FilterChip>
        <FilterChip
          active={preset === 'in_flight'}
          onClick={() => setPreset('in_flight')}
          count={counts.in_flight}
          tone="yellow"
        >
          In flight
        </FilterChip>
        <FilterChip
          active={preset === 'delivered_7d'}
          onClick={() => setPreset('delivered_7d')}
          count={counts.delivered_7d}
          tone="green"
        >
          Delivered 7d
        </FilterChip>
        <FilterChip
          active={preset === 'failed_today'}
          onClick={() => setPreset('failed_today')}
          count={counts.failed_today}
          tone="red"
        >
          Failed today
        </FilterChip>
        <FilterChip
          active={preset === 'refunded'}
          onClick={() => setPreset('refunded')}
          count={counts.refunded}
          tone="blue"
        >
          Refunded
        </FilterChip>
      </div>

      <Card padding={0}>
        {filtered.length === 0 ? (
          <EmptyState
            title={orders.length === 0 ? 'No orders yet' : 'No orders match your filters'}
            description="Orders appear here the moment an agent creates one — live over SSE."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Agent</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Asset</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((o) => (
                <tr key={o.id} onClick={() => setSelected(o)} style={{ cursor: 'pointer' }}>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.72rem',
                      color: 'var(--fg)',
                    }}
                  >
                    {o.id.slice(0, 8)}
                  </td>
                  <td style={{ fontSize: '0.76rem' }}>
                    {o.api_key_label || o.api_key_id.slice(0, 8)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.76rem',
                    }}
                  >
                    {formatUsd(o.amount_usdc)}
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--fg-dim)',
                    }}
                  >
                    {o.payment_asset}
                  </td>
                  <td>
                    <OrderStatusPill status={o.status} />
                  </td>
                  <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>
                    {timeAgo(o.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected && (
        <OrderDrawer
          order={selected}
          agentLabel={agents.find((a) => a.id === selected.api_key_id)?.label || null}
          onClose={() => setSelected(null)}
        />
      )}
    </PageContainer>
  );
}

function OrderDrawer({
  order,
  agentLabel,
  onClose,
}: {
  order: Order;
  agentLabel: string | null;
  onClose: () => void;
}) {
  return (
    <Drawer open={true} onClose={onClose} title={`Order ${order.id.slice(0, 8)}`} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <OrderStatusPill status={order.status} />
          <span style={{ fontSize: '0.72rem', color: 'var(--fg-dim)' }}>
            {timeAgo(order.created_at)}
          </span>
        </div>

        <Row label="Order ID">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{order.id}</span>
        </Row>
        <Row label="Agent">{agentLabel || order.api_key_id.slice(0, 8)}</Row>
        <Row label="Amount">
          <span style={{ fontFamily: 'var(--font-mono)' }}>{formatUsd(order.amount_usdc)}</span>
        </Row>
        <Row label="Payment asset">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }}>
            {order.payment_asset}
          </span>
        </Row>
        {order.stellar_txid && (
          <Row label="Stellar txid">
            <a
              href={`https://stellar.expert/explorer/public/tx/${order.stellar_txid}`}
              target="_blank"
              rel="noreferrer"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.72rem',
                color: 'var(--green)',
                textDecoration: 'none',
                wordBreak: 'break-all',
              }}
            >
              {order.stellar_txid.slice(0, 10)}…{order.stellar_txid.slice(-8)} ↗
            </a>
          </Row>
        )}
        {order.card_brand && <Row label="Card brand">{order.card_brand}</Row>}
        {order.error && (
          <div
            style={{
              background: 'var(--red-muted)',
              border: '1px solid var(--red-border)',
              padding: '0.7rem 0.85rem',
              borderRadius: 6,
              color: 'var(--red)',
              fontSize: '0.74rem',
            }}
          >
            {order.error}
          </div>
        )}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            paddingTop: '0.75rem',
            fontSize: '0.7rem',
            color: 'var(--fg-dim)',
          }}
        >
          Created: {new Date(order.created_at).toLocaleString()}
          <br />
          Updated: {new Date(order.updated_at).toLocaleString()}
        </div>
      </div>
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontSize: '0.64rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-dim)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--fg)' }}>{children}</div>
    </div>
  );
}
