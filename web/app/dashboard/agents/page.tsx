// Agents list — one row per api key. Sortable, filterable, searchable,
// with a top bar that shows the fleet-wide KPIs. Clicking a row opens
// the detail page at /dashboard/agents/:id.

'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useDashboard } from '../_lib/DashboardProvider';
import { Card } from '../_ui/Card';
import { Button } from '../_ui/Button';
import { EmptyState } from '../_ui/EmptyState';
import { Input } from '../_ui/Input';
import { AgentStatePill } from '../_ui/AgentStatePill';
import { FilterChip } from '../_ui/FilterChip';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { formatUsd, parseTimestamp, timeAgo, truncateAddress } from '../_lib/format';
import { AGENT_STATE_LABEL, AGENT_STATE_TONE } from '../_lib/constants';
import type { ApiKey, AgentStateName } from '../_lib/types';
import { CreateAgentDrawer } from '../_shell/CreateAgentDrawer';
import { useAgentGroups, useGroupsStorageSync } from '../_lib/groups';

export default function AgentsPage() {
  const { agents, walletBalances, orders } = useDashboard();
  useGroupsStorageSync();
  const groups = useAgentGroups();
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | AgentStateName>('all');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Unique groups present across all agents; drives the filter chips row.
  const uniqueGroups = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) {
      const g = groups[a.id];
      if (g) set.add(g);
    }
    return [...set].sort();
  }, [agents, groups]);

  // Spend-per-agent for the last 7d so we can surface fleet-wide
  // activity without an extra round-trip to the backend.
  const spend7d = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const map = new Map<string, number>();
    for (const o of orders) {
      if (o.status !== 'delivered') continue;
      if (parseTimestamp(o.created_at) < cutoff) continue;
      map.set(o.api_key_id, (map.get(o.api_key_id) || 0) + parseFloat(o.amount_usdc));
    }
    return map;
  }, [orders]);

  const filtered = useMemo(() => {
    let list = agents;
    if (stateFilter !== 'all') {
      list = list.filter((a) => (a.agent?.state ?? 'minted') === stateFilter);
    }
    if (groupFilter) {
      list = list.filter((a) => groups[a.id] === groupFilter);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((a) => {
        const label = (a.label || '').toLowerCase();
        const addr = (a.wallet_public_key || '').toLowerCase();
        const grp = (groups[a.id] || '').toLowerCase();
        return (
          label.includes(q) || addr.includes(q) || a.id.toLowerCase().includes(q) || grp.includes(q)
        );
      });
    }
    return list;
  }, [agents, query, stateFilter, groupFilter, groups]);

  const STATE_COUNTS: Record<'all' | AgentStateName, number> = {
    all: agents.length,
    minted: 0,
    initializing: 0,
    awaiting_funding: 0,
    funded: 0,
    active: 0,
    unknown: 0,
  };
  for (const a of agents) {
    const s = (a.agent?.state ?? 'minted') as AgentStateName;
    STATE_COUNTS[s] += 1;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Agents"
        subtitle={`${agents.length} total · ${STATE_COUNTS.active} active`}
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            + New agent
          </Button>
        }
      />

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, maxWidth: 340 }}>
          <Input
            placeholder="Search agents by name, address, id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <FilterChip
          active={stateFilter === 'all'}
          onClick={() => setStateFilter('all')}
          count={STATE_COUNTS.all}
        >
          All
        </FilterChip>
        {(
          ['active', 'funded', 'awaiting_funding', 'initializing', 'minted'] as AgentStateName[]
        ).map((s) => (
          <FilterChip
            key={s}
            active={stateFilter === s}
            onClick={() => setStateFilter(s)}
            count={STATE_COUNTS[s]}
            tone={AGENT_STATE_TONE[s]}
          >
            {AGENT_STATE_LABEL[s]}
          </FilterChip>
        ))}
      </div>

      {uniqueGroups.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '0.66rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--fg-dim)',
              marginRight: '0.25rem',
            }}
          >
            Group
          </span>
          <FilterChip
            active={groupFilter === null}
            onClick={() => setGroupFilter(null)}
            count={agents.length}
          >
            All
          </FilterChip>
          {uniqueGroups.map((g) => (
            <FilterChip
              key={g}
              active={groupFilter === g}
              onClick={() => setGroupFilter(g)}
              count={agents.filter((a) => groups[a.id] === g).length}
            >
              {g}
            </FilterChip>
          ))}
        </div>
      )}

      <Card padding={0}>
        {filtered.length === 0 ? (
          <EmptyState
            title={agents.length === 0 ? 'No agents yet' : 'No agents match your filters'}
            description={
              agents.length === 0
                ? 'Create your first agent to start issuing virtual cards on behalf of an AI.'
                : 'Try clearing the search or selecting a different state.'
            }
            cta={
              agents.length === 0 ? (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  + Create first agent
                </Button>
              ) : undefined
            }
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>State</th>
                <th>Group</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th style={{ textAlign: 'right' }}>Spent 7d</th>
                <th style={{ textAlign: 'right' }}>Total spent</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  group={groups[a.id] || null}
                  balanceXlm={walletBalances[a.id]?.xlm || '0'}
                  balanceUsdc={walletBalances[a.id]?.usdc || '0'}
                  spent7d={spend7d.get(a.id) || 0}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <CreateAgentDrawer open={createOpen} onClose={() => setCreateOpen(false)} />
    </PageContainer>
  );
}

function AgentRow({
  agent,
  group,
  balanceXlm,
  balanceUsdc,
  spent7d,
}: {
  agent: ApiKey;
  group: string | null;
  balanceXlm: string;
  balanceUsdc: string;
  spent7d: number;
}) {
  const state = (agent.agent?.state ?? 'minted') as AgentStateName;

  return (
    <tr style={{ cursor: 'pointer' }}>
      <td>
        <Link
          href={`/dashboard/agents/${agent.id}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            textDecoration: 'none',
            color: 'var(--fg)',
          }}
        >
          <span style={{ fontSize: '0.82rem', fontWeight: 500 }}>{agent.label || 'Unnamed'}</span>
          <span
            style={{
              fontSize: '0.68rem',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {truncateAddress(agent.wallet_public_key, 6, 4)}
          </span>
        </Link>
      </td>
      <td>
        <AgentStatePill state={state} />
      </td>
      <td style={{ fontSize: '0.74rem', color: group ? 'var(--fg)' : 'var(--fg-dim)' }}>
        {group ? (
          <span
            style={{
              display: 'inline-block',
              padding: '0.18rem 0.5rem',
              borderRadius: 4,
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
            }}
          >
            {group}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
        <div style={{ fontSize: '0.75rem' }}>{parseFloat(balanceUsdc).toFixed(2)} USDC</div>
        <div style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>
          {parseFloat(balanceXlm).toFixed(2)} XLM
        </div>
      </td>
      <td
        style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.78rem',
        }}
      >
        {formatUsd(spent7d)}
      </td>
      <td
        style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.78rem',
          color: 'var(--fg-dim)',
        }}
      >
        {formatUsd(agent.total_spent_usdc)}
      </td>
      <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>{timeAgo(agent.last_used_at)}</td>
    </tr>
  );
}
