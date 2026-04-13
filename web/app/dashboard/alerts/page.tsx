// Alerts — fleet health guardrails. Operators see:
//   - "My alerts" — user-level rules scoped to their own dashboard
//   - "System alerts" — platform-level rules (CTX auth, circuit breaker)
//     visible only when the current user is the platform owner
//   - Rule CRUD with optional notify-email / notify-webhook channels
//   - Recent firings with rule name and context
//
// All visibility gating is double-enforced: backend filters and rejects
// system kinds for non-owners, and the UI hides the same kinds.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '../_ui/Card';
import { Button } from '../_ui/Button';
import { Input } from '../_ui/Input';
import { Pill } from '../_ui/Pill';
import { Drawer } from '../_ui/Drawer';
import { EmptyState } from '../_ui/EmptyState';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { useToast } from '../_ui/Toast';
import { usePermissions } from '../_lib/usePermissions';
import { useDashboard } from '../_lib/DashboardProvider';
import {
  createAlertRule,
  deleteAlertRule,
  fetchAlertFirings,
  fetchAlertRules,
  updateAlertRule,
} from '../_lib/api';
import {
  isSystemAlertKind,
  type AlertFiring,
  type AlertKind,
  type AlertRule,
  type SystemAlertKind,
  type UserAlertKind,
} from '../_lib/types';
import { timeAgo } from '../_lib/format';

const KIND_META: Record<AlertKind, { title: string; blurb: string; scope: 'system' | 'user' }> = {
  ctx_auth_dead: {
    title: 'CTX auth expired',
    blurb: 'Fires when the CTX session is no longer valid. Fulfillment will 401 until re-auth.',
    scope: 'system',
  },
  circuit_breaker_frozen: {
    title: 'Fulfillment frozen',
    blurb: 'Fires when the cards402 tenant circuit breaker trips after repeated failures.',
    scope: 'system',
  },
  failure_rate_high: {
    title: 'My failure rate high',
    blurb: 'Fires when YOUR rolling failure rate exceeds the threshold.',
    scope: 'user',
  },
  spend_over: {
    title: 'My spend over threshold',
    blurb: 'Fires when YOUR delivered spend in a window exceeds the threshold.',
    scope: 'user',
  },
  agent_balance_low: {
    title: 'Agent balance running low',
    blurb: 'Fires when an agent has less than the threshold remaining of its spend limit.',
    scope: 'user',
  },
};

const USER_KIND_LIST: UserAlertKind[] = ['failure_rate_high', 'spend_over', 'agent_balance_low'];
const SYSTEM_KIND_LIST: SystemAlertKind[] = ['ctx_auth_dead', 'circuit_breaker_frozen'];

export default function AlertsPage() {
  const toast = useToast();
  const perms = usePermissions();
  const { user } = useDashboard();
  // is_platform_owner comes from /auth/me. Falls back to false until
  // the auth response lands so the system section never flashes for
  // a non-owner mid-load.
  const isPlatformOwner = !!user?.is_platform_owner;

  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [firings, setFirings] = useState<AlertFiring[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [r, f] = await Promise.all([fetchAlertRules(), fetchAlertFirings(50)]);
      setRules(r.rules);
      setFirings(f.firings);
    } catch (err) {
      toast.push((err as Error).message || 'failed to load alerts', 'error');
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { systemRules, userRules } = useMemo(() => {
    const list = rules ?? [];
    return {
      systemRules: list.filter((r) => isSystemAlertKind(r.kind)),
      userRules: list.filter((r) => !isSystemAlertKind(r.kind)),
    };
  }, [rules]);

  async function toggle(rule: AlertRule) {
    try {
      await updateAlertRule(rule.id, { enabled: !rule.enabled });
      await reload();
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    }
  }

  async function snooze(rule: AlertRule) {
    try {
      const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await updateAlertRule(rule.id, { snoozedUntil: until });
      toast.push('Snoozed for 1 hour', 'success');
      await reload();
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    }
  }

  async function remove(rule: AlertRule) {
    if (!confirm(`Delete alert rule "${rule.name}"?`)) return;
    try {
      await deleteAlertRule(rule.id);
      await reload();
      toast.push('Rule deleted', 'success');
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Alerts"
        subtitle="Rules that watch your agents and notify by email or webhook when they trip."
        actions={
          perms.can('alert:write') ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              + New rule
            </Button>
          ) : undefined
        }
      />

      <Card title="My alerts" padding={0}>
        {rules === null ? (
          <EmptyState title="Loading…" />
        ) : userRules.length === 0 ? (
          <EmptyState
            title="No personal rules yet"
            description="Set up a rule to be notified by email or webhook when your agents misbehave."
            cta={
              perms.can('alert:write') ? (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  + Create your first rule
                </Button>
              ) : undefined
            }
          />
        ) : (
          <RuleList
            rules={userRules}
            canEdit={perms.can('alert:write')}
            onToggle={toggle}
            onSnooze={snooze}
            onDelete={remove}
            onSavedNotify={async () => {
              await reload();
            }}
          />
        )}
      </Card>

      {isPlatformOwner && (
        <Card
          title={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              System alerts
              <Pill tone="purple">Platform owner</Pill>
            </span>
          }
          padding={0}
        >
          {rules === null ? (
            <EmptyState title="Loading…" />
          ) : systemRules.length === 0 ? (
            <EmptyState
              title="No system rules"
              description="The defaults will seed automatically the first time this page loads as platform owner."
            />
          ) : (
            <RuleList
              rules={systemRules}
              canEdit={perms.can('alert:write')}
              onToggle={toggle}
              onSnooze={snooze}
              onDelete={remove}
              onSavedNotify={async () => {
                await reload();
              }}
            />
          )}
        </Card>
      )}

      <Card title="Recent firings" padding={0}>
        {firings === null ? (
          <EmptyState title="Loading…" />
        ) : firings.length === 0 ? (
          <EmptyState
            title="No alerts have fired yet"
            description="Firings will appear here the moment any rule trips."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Kind</th>
                <th>Context</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {firings.map((f) => (
                <tr key={f.id}>
                  <td style={{ fontSize: '0.78rem' }}>{f.rule_name || '(deleted rule)'}</td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--fg-dim)',
                    }}
                  >
                    {f.kind || '—'}
                  </td>
                  <td
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--fg-dim)',
                      maxWidth: 420,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {JSON.stringify(f.context)}
                  </td>
                  <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>
                    {timeAgo(f.fired_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <CreateRuleDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        isPlatformOwner={isPlatformOwner}
        onCreated={async () => {
          setCreateOpen(false);
          await reload();
        }}
      />
    </PageContainer>
  );
}

function RuleList({
  rules,
  canEdit,
  onToggle,
  onSnooze,
  onDelete,
  onSavedNotify,
}: {
  rules: AlertRule[];
  canEdit: boolean;
  onToggle: (r: AlertRule) => void;
  onSnooze: (r: AlertRule) => void;
  onDelete: (r: AlertRule) => void;
  onSavedNotify: () => Promise<void>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rules.map((r) => (
        <RuleRow
          key={r.id}
          rule={r}
          canEdit={canEdit}
          onToggle={onToggle}
          onSnooze={onSnooze}
          onDelete={onDelete}
          onSavedNotify={onSavedNotify}
        />
      ))}
    </div>
  );
}

function RuleRow({
  rule,
  canEdit,
  onToggle,
  onSnooze,
  onDelete,
  onSavedNotify,
}: {
  rule: AlertRule;
  canEdit: boolean;
  onToggle: (r: AlertRule) => void;
  onSnooze: (r: AlertRule) => void;
  onDelete: (r: AlertRule) => void;
  onSavedNotify: () => Promise<void>;
}) {
  const toast = useToast();
  const [emailDraft, setEmailDraft] = useState(rule.notify_email ?? '');
  const [webhookDraft, setWebhookDraft] = useState(rule.notify_webhook_url ?? '');

  useEffect(() => {
    setEmailDraft(rule.notify_email ?? '');
    setWebhookDraft(rule.notify_webhook_url ?? '');
  }, [rule.notify_email, rule.notify_webhook_url]);

  async function saveNotify(field: 'email' | 'webhook') {
    const next =
      field === 'email'
        ? { notify_email: emailDraft.trim() || null }
        : { notify_webhook_url: webhookDraft.trim() || null };
    const current = field === 'email' ? rule.notify_email : rule.notify_webhook_url;
    const nextValue = field === 'email' ? next.notify_email : next.notify_webhook_url;
    if ((current ?? '') === (nextValue ?? '')) return;
    try {
      await updateAlertRule(rule.id, next);
      await onSavedNotify();
      toast.push(`${field === 'email' ? 'Email' : 'Webhook'} saved`, 'success');
    } catch (err) {
      toast.push((err as Error).message || 'save failed', 'error');
    }
  }

  return (
    <div
      style={{
        padding: '0.95rem 1.25rem',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.7rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: 3,
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--fg)' }}>
              {rule.name}
            </span>
            {rule.enabled ? (
              <Pill tone="green">Enabled</Pill>
            ) : (
              <Pill tone="neutral">Disabled</Pill>
            )}
            {rule.snoozed_until && Date.parse(rule.snoozed_until) > Date.now() && (
              <Pill tone="blue">Snoozed</Pill>
            )}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--fg-dim)' }}>
            {KIND_META[rule.kind]?.title || rule.kind} ·{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {Object.keys(rule.config).length > 0 ? JSON.stringify(rule.config) : 'no config'}
            </span>
          </div>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <Button size="sm" onClick={() => onToggle(rule)}>
              {rule.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button size="sm" onClick={() => onSnooze(rule)}>
              Snooze 1h
            </Button>
            <Button size="sm" variant="danger" onClick={() => onDelete(rule)}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {canEdit && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: '0.5rem',
          }}
        >
          <Input
            placeholder="Notify email (optional)"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onBlur={() => saveNotify('email')}
            type="email"
            prefix="✉"
          />
          <Input
            placeholder="Notify webhook URL (optional)"
            value={webhookDraft}
            onChange={(e) => setWebhookDraft(e.target.value)}
            onBlur={() => saveNotify('webhook')}
            prefix="↗"
          />
        </div>
      )}
    </div>
  );
}

function CreateRuleDrawer({
  open,
  onClose,
  onCreated,
  isPlatformOwner,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
  isPlatformOwner: boolean;
}) {
  const toast = useToast();
  const availableKinds: AlertKind[] = isPlatformOwner
    ? [...USER_KIND_LIST, ...SYSTEM_KIND_LIST]
    : [...USER_KIND_LIST];

  const [name, setName] = useState('');
  const [kind, setKind] = useState<AlertKind>('failure_rate_high');
  const [windowMinutes, setWindowMinutes] = useState('30');
  const [thresholdPct, setThresholdPct] = useState('20');
  const [thresholdUsd, setThresholdUsd] = useState('100');
  const [thresholdRemaining, setThresholdRemaining] = useState('10');
  const [notifyEmail, setNotifyEmail] = useState('');
  const [notifyWebhook, setNotifyWebhook] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setKind('failure_rate_high');
    setNotifyEmail('');
    setNotifyWebhook('');
  }, [open]);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const config: Record<string, unknown> = {};
      if (kind === 'failure_rate_high') {
        config.windowMinutes = Number(windowMinutes) || 30;
        config.thresholdPct = Number(thresholdPct) || 20;
      }
      if (kind === 'spend_over') {
        config.windowMinutes = Number(windowMinutes) || 60;
        config.thresholdUsd = Number(thresholdUsd) || 100;
      }
      if (kind === 'agent_balance_low') {
        config.thresholdRemainingUsd = Number(thresholdRemaining) || 10;
      }
      await createAlertRule({
        name: name.trim(),
        kind,
        config,
        notify_email: notifyEmail.trim() || null,
        notify_webhook_url: notifyWebhook.trim() || null,
      });
      toast.push('Rule created', 'success');
      await onCreated();
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="New alert rule">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <Label>Name</Label>
          <Input
            placeholder="e.g. My agents failing too often"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div>
          <Label>Kind</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {availableKinds.map((k) => {
              const meta = KIND_META[k];
              return (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    textAlign: 'left',
                    padding: '0.7rem 0.85rem',
                    background: kind === k ? 'var(--surface-2)' : 'transparent',
                    border: `1px solid ${kind === k ? 'var(--border-strong)' : 'var(--border)'}`,
                    borderRadius: 8,
                    color: 'var(--fg)',
                    cursor: 'pointer',
                    gap: 3,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      width: '100%',
                    }}
                  >
                    <span style={{ fontSize: '0.78rem', fontWeight: kind === k ? 600 : 500 }}>
                      {meta.title}
                    </span>
                    {meta.scope === 'system' && <Pill tone="purple">System</Pill>}
                  </div>
                  <span
                    style={{
                      fontSize: '0.68rem',
                      color: 'var(--fg-dim)',
                      lineHeight: 1.4,
                    }}
                  >
                    {meta.blurb}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {(kind === 'failure_rate_high' || kind === 'spend_over') && (
          <div>
            <Label>Config</Label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <Input
                type="number"
                prefix="window"
                suffix="minutes"
                value={windowMinutes}
                onChange={(e) => setWindowMinutes(e.target.value)}
              />
              {kind === 'failure_rate_high' ? (
                <Input
                  type="number"
                  prefix="threshold"
                  suffix="%"
                  value={thresholdPct}
                  onChange={(e) => setThresholdPct(e.target.value)}
                />
              ) : (
                <Input
                  type="number"
                  prefix="threshold"
                  suffix="USD"
                  value={thresholdUsd}
                  onChange={(e) => setThresholdUsd(e.target.value)}
                />
              )}
            </div>
          </div>
        )}
        {kind === 'agent_balance_low' && (
          <div>
            <Label>Config</Label>
            <Input
              type="number"
              prefix="remaining ≤"
              suffix="USD"
              value={thresholdRemaining}
              onChange={(e) => setThresholdRemaining(e.target.value)}
            />
          </div>
        )}
        <div>
          <Label>Notify channels (optional)</Label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <Input
              placeholder="email@example.com"
              type="email"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              prefix="✉"
            />
            <Input
              placeholder="https://your-service.example/alerts"
              value={notifyWebhook}
              onChange={(e) => setNotifyWebhook(e.target.value)}
              prefix="↗"
            />
          </div>
          <div
            style={{
              fontSize: '0.66rem',
              color: 'var(--fg-dim)',
              marginTop: '0.4rem',
              lineHeight: 1.5,
            }}
          >
            We&apos;ll deliver a JSON payload to the webhook and a plain-text summary to the email.
            Both are optional — leave blank to record firings to history only.
          </div>
        </div>
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !name.trim()}
          style={{ justifyContent: 'center' }}
        >
          {busy ? 'Creating…' : 'Create rule'}
        </Button>
      </div>
    </Drawer>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.66rem',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--fg-dim)',
        marginBottom: '0.4rem',
      }}
    >
      {children}
    </div>
  );
}
