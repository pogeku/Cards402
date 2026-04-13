// Teams page — realistic UX mock, entirely read-only, with a "Coming
// soon" pill at the page header. The current user renders in the
// members table so operators can see how they'll appear when real
// multi-user support lands (Phase 4). Everything else is disabled at
// the DOM level and visually dimmed via opacity + pointerEvents:none.

'use client';

import { useDashboard } from '../_lib/DashboardProvider';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { Card } from '../_ui/Card';
import { Button } from '../_ui/Button';
import { Pill } from '../_ui/Pill';
import { Input } from '../_ui/Input';
import { LabeledRow } from '../_ui/LabeledRow';
import { normalizeRole, type Role } from '../_lib/permissions';
import { timeAgo } from '../_lib/format';

const ROLES: { value: Role; label: string; blurb: string }[] = [
  { value: 'owner', label: 'Owner', blurb: 'Full access including account deletion.' },
  { value: 'admin', label: 'Admin', blurb: 'Everything except destroying the account.' },
  {
    value: 'operator',
    label: 'Operator',
    blurb: 'Create/edit/suspend agents, approve orders. Cannot delete or manage alerts.',
  },
  { value: 'viewer', label: 'Viewer', blurb: 'Read-only across the dashboard.' },
];

export default function TeamsPage() {
  const { user, info } = useDashboard();
  const role = normalizeRole(user?.role);

  return (
    <PageContainer>
      <PageHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
            Teams
            <Pill tone="blue">Coming soon</Pill>
          </span>
        }
        subtitle="Invite co-operators with roles, see who changed what, and delegate day-to-day ops."
        actions={
          <Button variant="primary" disabled>
            + Invite member
          </Button>
        }
      />

      <Card title="Members" padding={0}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Last active</th>
              <th>Joined</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'var(--green-muted)',
                      border: '1px solid var(--green-border)',
                      color: 'var(--green)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {user?.email?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div style={{ fontSize: '0.8rem' }}>
                    {user?.email || '—'}
                    <div
                      style={{
                        fontSize: '0.66rem',
                        color: 'var(--fg-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      you
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <Pill tone="green">{role}</Pill>
              </td>
              <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>Just now</td>
              <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>
                {timeAgo(info?.created_at)}
              </td>
              <td style={{ textAlign: 'right' }}>
                <Pill tone="neutral">Can&apos;t edit yourself</Pill>
              </td>
            </tr>
            <MockMemberRow
              email="teammate@example.com"
              role="admin"
              lastActive="2h ago"
              joined="3d ago"
            />
            <MockMemberRow
              email="finance@example.com"
              role="viewer"
              lastActive="1d ago"
              joined="2w ago"
            />
          </tbody>
        </table>
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: '1.25rem',
        }}
      >
        <Card title="Invite a member">
          <Disabled>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <LabeledRow label="Email">
                <Input placeholder="colleague@example.com" disabled style={{ minWidth: 220 }} />
              </LabeledRow>
              <LabeledRow label="Role" description="Determines what they can do in this dashboard.">
                <select
                  disabled
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    color: 'var(--fg)',
                    fontSize: '0.75rem',
                    padding: '0.4rem 0.6rem',
                    borderRadius: 6,
                    minWidth: 180,
                  }}
                >
                  <option>Admin</option>
                  <option>Operator</option>
                  <option>Viewer</option>
                </select>
              </LabeledRow>
              <Button variant="primary" disabled>
                Send invite
              </Button>
            </div>
          </Disabled>
        </Card>

        <Card title="Role reference">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {ROLES.map((r) => (
              <div
                key={r.value}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  padding: '0.55rem 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <Pill tone={r.value === role ? 'green' : 'neutral'}>{r.label}</Pill>
                  {r.value === role && (
                    <span style={{ fontSize: '0.66rem', color: 'var(--fg-dim)' }}>your role</span>
                  )}
                </div>
                <div style={{ fontSize: '0.74rem', color: 'var(--fg-dim)', lineHeight: 1.5 }}>
                  {r.blurb}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Why teams isn't live yet">
        <div style={{ fontSize: '0.78rem', color: 'var(--fg-muted)', lineHeight: 1.6 }}>
          Multi-user support needs a few backend changes — per-user sessions, an invite flow, a new{' '}
          <code>dashboard_members</code> table, and audit trails on every mutation. The permission
          matrix and server-side role gating are already in place (see{' '}
          <code>backend/src/lib/permissions.js</code>), so wiring real teams on top is mostly
          plumbing. It ships in the next phase.
        </div>
      </Card>
    </PageContainer>
  );
}

function Disabled({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ opacity: 0.55, pointerEvents: 'none', userSelect: 'none' }} aria-disabled>
      {children}
    </div>
  );
}

function MockMemberRow({
  email,
  role,
  lastActive,
  joined,
}: {
  email: string;
  role: Role;
  lastActive: string;
  joined: string;
}) {
  return (
    <tr style={{ opacity: 0.55 }}>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {email[0]?.toUpperCase()}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--fg-muted)' }}>{email}</div>
        </div>
      </td>
      <td>
        <Pill tone="neutral">{role}</Pill>
      </td>
      <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>{lastActive}</td>
      <td style={{ color: 'var(--fg-dim)', fontSize: '0.72rem' }}>{joined}</td>
      <td style={{ textAlign: 'right' }}>
        <Pill tone="neutral">Preview</Pill>
      </td>
    </tr>
  );
}
