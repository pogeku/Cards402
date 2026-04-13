// Audit log viewer — paginated list of every mutating dashboard
// action. Filter by action type or actor email. Click a row to see
// the full JSON details in a drawer.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '../_ui/Card';
import { Input } from '../_ui/Input';
import { Pill } from '../_ui/Pill';
import { Drawer } from '../_ui/Drawer';
import { EmptyState } from '../_ui/EmptyState';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { useToast } from '../_ui/Toast';
import { fetchAuditLog } from '../_lib/api';
import type { AuditLogEntry } from '../_lib/types';
import { timeAgo } from '../_lib/format';

const ACTION_TONE: Record<string, 'green' | 'red' | 'yellow' | 'blue' | 'purple' | 'neutral'> = {
  'agent.create': 'green',
  'agent.update': 'blue',
  'agent.delete': 'red',
  'agent.suspend': 'yellow',
  'agent.unsuspend': 'green',
  'approval.approve': 'green',
  'approval.reject': 'red',
  'alert.create': 'green',
  'alert.update': 'blue',
  'alert.delete': 'red',
  'webhook.test': 'purple',
};

export default function AuditLogPage() {
  const toast = useToast();
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  const reload = useCallback(async () => {
    try {
      const { entries } = await fetchAuditLog({ limit: 200 });
      setEntries(entries);
    } catch (err) {
      toast.push((err as Error).message || 'failed to load audit log', 'error');
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = entries?.filter((e) => {
    if (actionFilter && !e.action.startsWith(actionFilter)) return false;
    if (query.trim()) {
      const q = query.toLowerCase();
      if (
        !e.action.toLowerCase().includes(q) &&
        !e.actor_email.toLowerCase().includes(q) &&
        !(e.resource_id?.toLowerCase() ?? '').includes(q)
      ) {
        return false;
      }
    }
    return true;
  });

  const actionTypes = entries
    ? Array.from(new Set(entries.map((e) => e.action.split('.')[0] ?? e.action))).sort()
    : [];

  return (
    <PageContainer>
      <PageHeader
        title="Audit log"
        subtitle="Every mutating action taken on this dashboard. Immutable, append-only."
      />

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, maxWidth: 340 }}>
          <Input
            placeholder="Search action, actor, resource id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontSize: '0.75rem',
            padding: '0.4rem 0.6rem',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        >
          <option value="">All actions</option>
          {actionTypes.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <Card padding={0}>
        {entries === null ? (
          <EmptyState title="Loading…" />
        ) : !filtered || filtered.length === 0 ? (
          <EmptyState
            title={entries.length === 0 ? 'No activity yet' : 'No entries match your filters'}
            description="Actions like creating or editing agents, approving orders, and managing alerts appear here."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} onClick={() => setSelected(e)} style={{ cursor: 'pointer' }}>
                  <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>
                    {timeAgo(e.created_at)}
                  </td>
                  <td style={{ fontSize: '0.76rem' }}>
                    {e.actor_email}
                    <div
                      style={{
                        fontSize: '0.64rem',
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {e.actor_role}
                    </div>
                  </td>
                  <td>
                    <Pill tone={ACTION_TONE[e.action] ?? 'neutral'}>{e.action}</Pill>
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--fg-dim)',
                    }}
                  >
                    {e.resource_type || '—'}
                    {e.resource_id ? ` · ${e.resource_id.slice(0, 12)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {selected && (
        <Drawer open={true} onClose={() => setSelected(null)} title={selected.action} width={520}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <DetailRow label="When">{new Date(selected.created_at).toLocaleString()}</DetailRow>
            <DetailRow label="Actor">{selected.actor_email}</DetailRow>
            <DetailRow label="Role">
              <Pill tone="neutral">{selected.actor_role}</Pill>
            </DetailRow>
            <DetailRow label="Resource type">{selected.resource_type || '—'}</DetailRow>
            <DetailRow label="Resource id">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem' }}>
                {selected.resource_id || '—'}
              </span>
            </DetailRow>
            {selected.ip && <DetailRow label="IP">{selected.ip}</DetailRow>}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
              <div
                style={{
                  fontSize: '0.64rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-dim)',
                  marginBottom: '0.35rem',
                }}
              >
                Details
              </div>
              <pre
                style={{
                  fontSize: '0.72rem',
                  margin: 0,
                  background: 'var(--surface-2)',
                  padding: '0.75rem 0.85rem',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {selected.details ? JSON.stringify(selected.details, null, 2) : '(none)'}
              </pre>
            </div>
          </div>
        </Drawer>
      )}
    </PageContainer>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontSize: '0.62rem',
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
