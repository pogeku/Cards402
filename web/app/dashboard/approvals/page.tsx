// Approvals — human-in-the-loop decisions on orders that exceeded
// the "require approval above" threshold on an agent. DashboardProvider
// already exposes the approvals array; this page just renders them
// with approve/reject actions.

'use client';

import { useState } from 'react';
import { useDashboard } from '../_lib/DashboardProvider';
import { Card } from '../_ui/Card';
import { Pill } from '../_ui/Pill';
import { Button } from '../_ui/Button';
import { EmptyState } from '../_ui/EmptyState';
import { useToast } from '../_ui/Toast';
import { approveOrder, rejectOrder } from '../_lib/api';
import { formatUsd, timeAgo } from '../_lib/format';

export default function ApprovalsPage() {
  const { approvals, refresh } = useDashboard();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      if (approve) {
        await approveOrder(id);
        toast.push('Order approved', 'success');
      } else {
        await rejectOrder(id);
        toast.push('Order rejected', 'success');
      }
      await refresh();
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        padding: '1.5rem 1.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
        maxWidth: 1100,
      }}
    >
      <div>
        <div style={{ fontSize: '1.35rem', fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>
          Approvals
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)' }}>
          {approvals.length} pending{' '}
          {approvals.length > 0 && (
            <span>
              · orders that exceeded an agent's approval threshold and need a human decision
            </span>
          )}
        </div>
      </div>

      <Card padding={0}>
        {approvals.length === 0 ? (
          <EmptyState
            title="No pending approvals"
            description="Orders that exceed an agent's approval threshold will land here for review."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {approvals.map((a) => (
              <div
                key={a.id}
                style={{
                  padding: '1rem 1.25rem',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.55rem',
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--fg)' }}>
                      {a.api_key_label || a.api_key_id.slice(0, 8)}
                    </span>
                    <Pill tone="yellow" pulse>
                      Pending
                    </Pill>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      order {a.order_id.slice(0, 8)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: '1rem',
                      fontSize: '0.78rem',
                      color: 'var(--fg-dim)',
                      marginBottom: 4,
                    }}
                  >
                    <span>
                      <strong
                        style={{
                          color: 'var(--fg)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {formatUsd(a.amount_usdc)}
                      </strong>
                    </span>
                    <span>requested {timeAgo(a.requested_at)}</span>
                    <span>expires {timeAgo(a.expires_at)}</span>
                  </div>
                  {a.agent_note && (
                    <div
                      style={{
                        fontSize: '0.76rem',
                        color: 'var(--fg-muted)',
                        fontStyle: 'italic',
                        background: 'var(--surface-2)',
                        padding: '0.55rem 0.8rem',
                        borderRadius: 6,
                        marginTop: 6,
                        border: '1px solid var(--border)',
                      }}
                    >
                      "{a.agent_note}"
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => decide(a.id, false)}
                    disabled={busy === a.id}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => decide(a.id, true)}
                    disabled={busy === a.id}
                  >
                    Approve
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
