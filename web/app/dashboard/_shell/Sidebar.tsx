// Left navigation. Sectioned (Main / Teams / Administration) matching
// the Ampersand pattern. Icons are bundled inline as small SVGs so we
// don't pull in a whole icon library for Phase 1.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useDashboard } from '../_lib/DashboardProvider';
import { usePermissions } from '../_lib/usePermissions';
import type { Permission } from '../_lib/permissions';
import { Wordmark } from '@/app/components/Wordmark';

interface Item {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: 'approvals';
  permission?: Permission;
}
interface Section {
  label?: string;
  items: Item[];
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const SECTIONS: Section[] = [
  {
    items: [
      {
        href: '/dashboard/overview',
        label: 'Overview',
        icon: <Icon d="M3 12h4l3-9 4 18 3-9h4" />,
        permission: 'dashboard:read',
      },
      {
        href: '/dashboard/agents',
        label: 'Agents',
        icon: (
          <Icon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" />
        ),
        permission: 'agent:read',
      },
      {
        href: '/dashboard/orders',
        label: 'Orders',
        icon: (
          <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8" />
        ),
        permission: 'order:read',
      },
      {
        href: '/dashboard/approvals',
        label: 'Approvals',
        icon: <Icon d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
        badge: 'approvals',
        permission: 'approval:read',
      },
      {
        href: '/dashboard/analytics',
        label: 'Analytics',
        icon: <Icon d="M3 3v18h18M7 13l4-4 4 4 6-6" />,
        permission: 'dashboard:read',
      },
      {
        href: '/dashboard/merchants',
        label: 'Merchants',
        icon: <Icon d="M3 9l2-5h14l2 5M3 9h18v11H3zM8 14h8" />,
        permission: 'merchant:read',
      },
    ],
  },
  {
    label: 'Developer',
    items: [
      {
        href: '/dashboard/developer',
        label: 'Webhooks',
        icon: (
          <Icon d="M8 12h8M8 8h8M8 16h4M4 6v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z" />
        ),
        permission: 'webhook:read',
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        href: '/dashboard/alerts',
        label: 'Alerts',
        icon: <Icon d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />,
        permission: 'alert:read',
      },
      {
        href: '/dashboard/audit',
        label: 'Audit log',
        icon: <Icon d="M9 12l2 2 4-4M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" />,
        permission: 'audit:read',
      },
      {
        href: '/dashboard/teams',
        label: 'Teams',
        icon: (
          <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        ),
        permission: 'team:manage',
      },
      {
        href: '/dashboard/settings',
        label: 'Settings',
        icon: (
          <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.39 1.25 1 1.51H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        ),
        permission: 'dashboard:read',
      },
      {
        href: '/dashboard/feedback',
        label: 'Feedback',
        icon: (
          <Icon d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        ),
      },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { approvals } = useDashboard();
  const perms = usePermissions();
  const approvalCount = approvals.length;

  return (
    <aside
      className="dashboard-sidebar"
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        padding: '0.75rem 0.5rem 1rem',
        gap: '1rem',
        position: 'sticky',
        top: 0,
        height: '100vh',
        overflowY: 'auto',
      }}
    >
      <Link
        href="/dashboard/overview"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          padding: '0.55rem 0.75rem',
          textDecoration: 'none',
          color: 'var(--fg)',
        }}
      >
        <Wordmark height={18} />
        <span
          style={{
            fontSize: '0.54rem',
            color: 'var(--fg-dim)',
            padding: '0.12rem 0.38rem',
            border: '1px solid var(--border)',
            borderRadius: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Beta
        </span>
      </Link>

      {SECTIONS.map((section, sIdx) => {
        const visible = section.items.filter((i) => !i.permission || perms.can(i.permission));
        if (visible.length === 0) return null;
        return (
          <div key={sIdx} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
            {section.label && (
              <div
                style={{
                  fontSize: '0.62rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--fg-dim)',
                  padding: '0.35rem 0.75rem 0.25rem',
                  fontWeight: 600,
                }}
              >
                {section.label}
              </div>
            )}
            {visible.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/');
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 6,
                    fontSize: '0.8rem',
                    fontWeight: active ? 600 : 500,
                    color: active ? 'var(--fg)' : 'var(--fg-muted)',
                    background: active ? 'var(--surface)' : 'transparent',
                    textDecoration: 'none',
                    transition: 'background 120ms, color 120ms',
                  }}
                >
                  <span style={{ color: active ? 'var(--fg)' : 'var(--fg-dim)' }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.badge === 'approvals' && approvalCount > 0 && (
                    <span
                      style={{
                        minWidth: 16,
                        height: 16,
                        padding: '0 4px',
                        borderRadius: 8,
                        background: 'var(--yellow)',
                        color: '#000',
                        fontSize: '0.6rem',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {approvalCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
