// Agent detail — Ampersand-style layout. Main column has breadcrumb,
// KPI row, spend chart, recent activity. Sticky right pane houses every
// per-agent toggle and action.

'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useDashboard } from '../../_lib/DashboardProvider';
import { KpiTile, KpiRow } from '../../_ui/KpiTile';
import { Card } from '../../_ui/Card';
import { Pill } from '../../_ui/Pill';
import { Button } from '../../_ui/Button';
import { Toggle } from '../../_ui/Toggle';
import { Input } from '../../_ui/Input';
import { EmptyState } from '../../_ui/EmptyState';
import { SpendChart } from '../../_ui/SpendChart';
import { Drawer } from '../../_ui/Drawer';
import { QrCode } from '../../_ui/QrCode';
import { AgentStatePill } from '../../_ui/AgentStatePill';
import { OrderStatusPill } from '../../_ui/OrderStatusPill';
import { useToast } from '../../_ui/Toast';
import { formatUsd, timeAgo, truncateAddress, bucketSpendByDay } from '../../_lib/format';
import { IN_FLIGHT_ORDER_STATUSES } from '../../_lib/constants';
import type { AgentStateName } from '../../_lib/types';
import { updateAgent, deleteAgent, suspendAgent } from '../../_lib/api';
import { setAgentGroup, useAgentGroup } from '../../_lib/groups';

type PageProps = { params: Promise<{ id: string }> };

export default function AgentDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const { agents, orders, walletBalances, refresh } = useDashboard();
  const agent = agents.find((a) => a.id === id);
  const toast = useToast();
  const [topUpOpen, setTopUpOpen] = useState(false);
  const group = useAgentGroup(id);
  const [groupDraft, setGroupDraft] = useState<string>('');

  // Keep the draft in sync whenever the stored group changes (e.g. after
  // the user commits a new value or opens the page). This MUST be a
  // useEffect — a setState inside useMemo is an anti-pattern that
  // triggers React error #185 (infinite update loop).
  useEffect(() => {
    setGroupDraft(group ?? '');
  }, [group]);

  // Reuse hooks on every render but early-bail on missing data
  const agentOrders = useMemo(() => orders.filter((o) => o.api_key_id === id), [orders, id]);
  const chartData = useMemo(() => bucketSpendByDay(agentOrders, 14), [agentOrders]);
  const stats = useMemo(() => {
    const delivered = agentOrders.filter((o) => o.status === 'delivered');
    const failed = agentOrders.filter((o) => o.status === 'failed');
    const pending = agentOrders.filter((o) => IN_FLIGHT_ORDER_STATUSES.has(o.status));
    const spend = delivered.reduce((s, o) => s + (parseFloat(o.amount_usdc) || 0), 0);
    const successRate =
      delivered.length + failed.length === 0
        ? 100
        : (delivered.length / (delivered.length + failed.length)) * 100;
    return {
      spend,
      delivered: delivered.length,
      failed: failed.length,
      pending: pending.length,
      successRate,
    };
  }, [agentOrders]);

  if (!agent) {
    return (
      <div style={{ padding: '2rem' }}>
        <EmptyState
          title="Agent not found"
          description="This agent may have been deleted."
          cta={
            <Link href="/dashboard/agents">
              <Button>← Back to agents</Button>
            </Link>
          }
        />
      </div>
    );
  }

  // After narrowing: capture a local non-null ref so the callbacks
  // defined below don't need to deal with the widened type.
  const liveAgent = agent;
  const state = (liveAgent.agent?.state ?? 'minted') as AgentStateName;
  const balXlm = walletBalances[liveAgent.id]?.xlm || '0';
  const balUsdc = walletBalances[liveAgent.id]?.usdc || '0';
  const comboUsd = parseFloat(balUsdc) + parseFloat(balXlm) * 0.2; /* rough XLM/USD heuristic */

  async function patch(body: Parameters<typeof updateAgent>[1]) {
    try {
      await updateAgent(id, body);
      await refresh();
      toast.push('Agent updated', 'success');
    } catch (err) {
      toast.push((err as Error).message || 'update failed', 'error');
    }
  }

  async function handleSuspend() {
    try {
      await suspendAgent(id, !liveAgent.suspended);
      await refresh();
      toast.push(liveAgent.suspended ? 'Agent resumed' : 'Agent suspended', 'success');
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete agent "${liveAgent.label || liveAgent.id}"? This cannot be undone.`))
      return;
    try {
      await deleteAgent(id);
      await refresh();
      toast.push('Agent deleted', 'success');
      window.location.href = '/dashboard/agents';
    } catch (err) {
      toast.push((err as Error).message || 'delete failed', 'error');
    }
  }

  return (
    <div
      className="dashboard-agent-detail-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 340px',
        gap: 0,
        minHeight: '100%',
      }}
    >
      {/* MAIN COLUMN */}
      <div
        style={{
          padding: '1.5rem 1.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          minWidth: 0,
        }}
      >
        <div>
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--fg-dim)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              marginBottom: 4,
            }}
          >
            <Link
              href="/dashboard/agents"
              style={{ color: 'var(--fg-dim)', textDecoration: 'none' }}
            >
              Agents
            </Link>
            <span>/</span>
            <span style={{ color: 'var(--fg)' }}>{agent.label || 'Unnamed'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
            <div style={{ fontSize: '1.35rem', fontWeight: 600, color: 'var(--fg)' }}>
              {agent.label || 'Unnamed agent'}
            </div>
            <AgentStatePill state={state} />
            {agent.suspended ? <Pill tone="red">Suspended</Pill> : null}
          </div>
          <div
            style={{
              fontSize: '0.72rem',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--font-mono)',
              marginTop: 4,
            }}
          >
            {truncateAddress(agent.wallet_public_key, 8, 6)}
          </div>
        </div>

        <KpiRow>
          <KpiTile label="Total spent" value={formatUsd(agent.total_spent_usdc)} />
          <KpiTile
            label="Delivered"
            value={stats.delivered}
            hint={`${stats.successRate.toFixed(0)}% success`}
          />
          <KpiTile
            label="Failed"
            value={stats.failed}
            hint={stats.pending > 0 ? `${stats.pending} in flight` : undefined}
          />
          <KpiTile
            label="Balance"
            value={formatUsd(comboUsd)}
            hint={`${parseFloat(balXlm).toFixed(2)} XLM · ${parseFloat(balUsdc).toFixed(2)} USDC`}
          />
        </KpiRow>

        <Card title="Spend — last 14 days">
          <SpendChart data={chartData} height={200} />
        </Card>

        <Card title="Recent orders" padding={0}>
          {agentOrders.length === 0 ? (
            <EmptyState
              title="No orders yet"
              description="This agent hasn't issued any cards yet. Orders will show up here when it does."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Asset</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {agentOrders.slice(0, 15).map((o) => (
                  <tr key={o.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                      {o.id.slice(0, 8)}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.75rem',
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
      </div>

      {/* RIGHT PANE */}
      <aside
        style={{
          width: 340,
          flexShrink: 0,
          borderLeft: '1px solid var(--border)',
          background: 'var(--bg)',
          padding: '1.25rem 1.25rem 2rem',
          position: 'sticky',
          top: 52,
          alignSelf: 'flex-start',
          height: 'calc(100vh - 52px)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <section>
          <div
            style={{
              fontSize: '0.66rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--fg-dim)',
              marginBottom: '0.4rem',
            }}
          >
            Agent Balance
          </div>
          <div
            style={{
              fontSize: '1.4rem',
              fontFamily: 'var(--font-mono)',
              color: 'var(--fg)',
              fontWeight: 600,
            }}
          >
            {formatUsd(comboUsd)}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-dim)', marginTop: 2 }}>
            {parseFloat(balXlm).toFixed(4)} XLM · {parseFloat(balUsdc).toFixed(2)} USDC
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem' }}>
            <Button size="sm" onClick={() => setTopUpOpen(true)} style={{ flex: 1 }}>
              Top up
            </Button>
            <Button size="sm" style={{ flex: 1 }} disabled>
              Send
            </Button>
          </div>
        </section>

        <section style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.4rem',
            }}
          >
            <div
              style={{
                fontSize: '0.66rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--fg-dim)',
              }}
            >
              Auto top-up
            </div>
            <Pill tone="blue">Coming soon</Pill>
          </div>
          <div
            style={{
              fontSize: '0.68rem',
              color: 'var(--fg-dim)',
              lineHeight: 1.5,
              marginBottom: '0.6rem',
            }}
          >
            Automatically transfer from the operator treasury when the agent&apos;s balance drops
            below a threshold.
          </div>
          <div
            style={{
              opacity: 0.55,
              pointerEvents: 'none',
              userSelect: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.55rem',
            }}
            aria-disabled
          >
            <div>
              <div
                style={{
                  fontSize: '0.62rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-dim)',
                  marginBottom: 3,
                }}
              >
                Trigger when below
              </div>
              <Input prefix="$" placeholder="5.00" disabled />
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.62rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-dim)',
                  marginBottom: 3,
                }}
              >
                Top up to
              </div>
              <Input prefix="$" placeholder="50.00" disabled />
            </div>
            <div>
              <div
                style={{
                  fontSize: '0.62rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-dim)',
                  marginBottom: 3,
                }}
              >
                Source
              </div>
              <div
                style={{
                  padding: '0.45rem 0.7rem',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: '0.72rem',
                  color: 'var(--fg-dim)',
                }}
              >
                Operator treasury (USDC)
              </div>
            </div>
            <Button variant="primary" style={{ justifyContent: 'center' }} disabled>
              Enable auto top-up
            </Button>
          </div>
        </section>

        <section style={{ borderTop: '1px solid var(--border)', paddingTop: '0.25rem' }}>
          <LimitToggle
            label="Daily spending limit"
            value={agent.policy_daily_limit_usdc}
            onCommit={(v) => patch({ policy_daily_limit_usdc: v })}
          />
          <LimitToggle
            label="Monthly spending limit"
            value={agent.spend_limit_usdc}
            onCommit={(v) => patch({ spend_limit_usdc: v })}
          />
          <LimitToggle
            label="Per-order limit"
            value={agent.policy_single_tx_limit_usdc}
            onCommit={(v) => patch({ policy_single_tx_limit_usdc: v })}
          />
          <LimitToggle
            label="Require approval above"
            value={agent.policy_require_approval_above_usdc}
            onCommit={(v) => patch({ policy_require_approval_above_usdc: v })}
          />
          <Toggle
            checked={false}
            onChange={() => toast.push('Auto-sweep coming soon', 'info')}
            label="Auto-sweep unused funds"
            description="Return the agent's unused balance to the operator treasury nightly."
          />
        </section>

        <section style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          <div
            style={{
              fontSize: '0.66rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--fg-dim)',
              marginBottom: '0.5rem',
            }}
          >
            Group
          </div>
          <Input
            placeholder="e.g. prod, research"
            value={groupDraft}
            onChange={(e) => setGroupDraft(e.target.value)}
            onBlur={() => {
              const next = groupDraft.trim() || null;
              if (next !== group) {
                setAgentGroup(id, next);
                toast.push(next ? `Moved to ${next}` : 'Removed from group', 'success');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <div style={{ fontSize: '0.66rem', color: 'var(--fg-dim)', marginTop: '0.35rem' }}>
            Operator-local for now. Team-synced groups land with the Teams feature.
          </div>
        </section>

        <section style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          <div
            style={{
              fontSize: '0.66rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--fg-dim)',
              marginBottom: '0.5rem',
            }}
          >
            Webhook
          </div>
          <div
            style={{
              fontSize: '0.7rem',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
              padding: '0.5rem 0.65rem',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            {agent.default_webhook_url || 'Not configured'}
          </div>
        </section>

        <section style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          <div
            style={{
              fontSize: '0.66rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--fg-dim)',
              marginBottom: '0.5rem',
            }}
          >
            Danger zone
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <Button onClick={handleSuspend} variant="secondary" size="sm">
              {agent.suspended ? 'Resume agent' : 'Suspend agent'}
            </Button>
            <Button onClick={handleDelete} variant="danger" size="sm">
              Delete agent
            </Button>
          </div>
        </section>
      </aside>

      <Drawer
        open={topUpOpen}
        onClose={() => setTopUpOpen(false)}
        title={`Fund ${agent.label || 'agent'}`}
      >
        {agent.wallet_public_key ? (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}
          >
            <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)', textAlign: 'center' }}>
              Send XLM or USDC to this address to fund the agent. Funds show up on the dashboard
              within ~30 seconds.
            </div>
            <QrCode text={agent.wallet_public_key} size={240} />
            <div
              style={{
                fontSize: '0.72rem',
                fontFamily: 'var(--font-mono)',
                padding: '0.65rem 0.85rem',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                wordBreak: 'break-all',
                textAlign: 'center',
              }}
            >
              {agent.wallet_public_key}
            </div>
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(agent.wallet_public_key || '');
                toast.push('Address copied', 'success');
              }}
            >
              Copy address
            </Button>
          </div>
        ) : (
          <EmptyState
            title="No wallet yet"
            description="This agent hasn't been onboarded yet. Once the claim code is redeemed and a wallet is created, a deposit address will appear here."
          />
        )}
      </Drawer>
    </div>
  );
}

function LimitToggle({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string | null;
  onCommit: (next: string | null) => void;
}) {
  const [enabled, setEnabled] = useState(!!value);
  const [draft, setDraft] = useState(value || '');

  function handleToggle(next: boolean) {
    setEnabled(next);
    if (!next) onCommit(null);
  }

  function commit() {
    if (!enabled) return;
    const parsed = parseFloat(draft);
    if (!isFinite(parsed) || parsed <= 0) return;
    onCommit(parsed.toFixed(2));
  }

  return (
    <Toggle checked={enabled} onChange={handleToggle} label={label} description="In USD">
      {enabled && (
        <Input
          type="number"
          placeholder="0.00"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          prefix="$"
        />
      )}
    </Toggle>
  );
}
