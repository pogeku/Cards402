// ⌘K command palette. Global navigation + quick actions, with fuzzy
// matching across a small fixed menu + every loaded agent and order.
// Closes on Enter, Escape, or a click outside.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../_lib/DashboardProvider';
import { usePermissions } from '../_lib/usePermissions';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../_ui/theme';
import { logout } from '../_lib/api';
import type { Permission } from '../_lib/permissions';

interface Command {
  id: string;
  title: string;
  hint?: string;
  section: 'Go to' | 'Agents' | 'Orders' | 'Actions';
  run: () => void;
  permission?: Permission;
}

export function CommandPalette() {
  const router = useRouter();
  const { agents, orders } = useDashboard();
  const perms = usePermissions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
  }, []);

  // ⌘K / Ctrl+K toggles the palette. `?` opens the keyboard-shortcut
  // overlay once we build one; for now it just opens the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (!inEditable) {
        // `g` prefix shortcuts: g + a = agents, g + o = orders, etc.
        if (e.key === 'g') {
          e.preventDefault();
          const handler = (evt: KeyboardEvent) => {
            window.removeEventListener('keydown', handler);
            const map: Record<string, string> = {
              o: '/dashboard/overview',
              a: '/dashboard/agents',
              r: '/dashboard/orders',
              p: '/dashboard/approvals',
              n: '/dashboard/analytics',
              m: '/dashboard/merchants',
              s: '/dashboard/settings',
              d: '/dashboard/developer',
              l: '/dashboard/alerts',
              u: '/dashboard/audit',
            };
            const path = map[evt.key.toLowerCase()];
            if (path) router.push(path);
          };
          window.addEventListener('keydown', handler, { once: true });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const baseCommands = useMemo<Command[]>(
    () => [
      {
        id: 'nav-overview',
        title: 'Go to Overview',
        hint: 'g o',
        section: 'Go to',
        run: () => router.push('/dashboard/overview'),
        permission: 'dashboard:read',
      },
      {
        id: 'nav-agents',
        title: 'Go to Agents',
        hint: 'g a',
        section: 'Go to',
        run: () => router.push('/dashboard/agents'),
        permission: 'agent:read',
      },
      {
        id: 'nav-orders',
        title: 'Go to Orders',
        hint: 'g r',
        section: 'Go to',
        run: () => router.push('/dashboard/orders'),
        permission: 'order:read',
      },
      {
        id: 'nav-approvals',
        title: 'Go to Approvals',
        hint: 'g p',
        section: 'Go to',
        run: () => router.push('/dashboard/approvals'),
        permission: 'approval:read',
      },
      {
        id: 'nav-analytics',
        title: 'Go to Analytics',
        hint: 'g n',
        section: 'Go to',
        run: () => router.push('/dashboard/analytics'),
        permission: 'dashboard:read',
      },
      {
        id: 'nav-alerts',
        title: 'Go to Alerts',
        hint: 'g l',
        section: 'Go to',
        run: () => router.push('/dashboard/alerts'),
        permission: 'alert:read',
      },
      {
        id: 'nav-audit',
        title: 'Go to Audit log',
        hint: 'g u',
        section: 'Go to',
        run: () => router.push('/dashboard/audit'),
        permission: 'audit:read',
      },
      {
        id: 'nav-developer',
        title: 'Go to Developer',
        hint: 'g d',
        section: 'Go to',
        run: () => router.push('/dashboard/developer'),
        permission: 'webhook:read',
      },
      {
        id: 'nav-settings',
        title: 'Go to Settings',
        hint: 'g s',
        section: 'Go to',
        run: () => router.push('/dashboard/settings'),
      },
      {
        id: 'action-new-agent',
        title: 'Create new agent',
        section: 'Actions',
        run: () => router.push('/dashboard/agents?new=1'),
        permission: 'agent:create',
      },
      {
        id: 'action-toggle-theme',
        title: 'Cycle theme (dark → light → system)',
        section: 'Actions',
        run: () => {
          const current = loadTheme();
          const next: Theme =
            current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark';
          saveTheme(next);
          applyTheme(next);
        },
      },
      {
        id: 'action-feedback',
        title: 'Send feedback',
        section: 'Actions',
        run: () => router.push('/dashboard/feedback'),
      },
      {
        id: 'action-logout',
        title: 'Sign out',
        section: 'Actions',
        run: async () => {
          await logout();
          router.push('/');
        },
      },
    ],
    [router],
  );

  const dynamicCommands = useMemo<Command[]>(() => {
    const agentCmds: Command[] = agents.slice(0, 30).map((a) => ({
      id: `agent-${a.id}`,
      title: a.label || 'Unnamed agent',
      hint: a.id.slice(0, 8),
      section: 'Agents',
      run: () => router.push(`/dashboard/agents/${a.id}`),
      permission: 'agent:read',
    }));
    const orderCmds: Command[] = orders.slice(0, 20).map((o) => ({
      id: `order-${o.id}`,
      title: `Order ${o.id.slice(0, 8)}`,
      hint: `$${o.amount_usdc} · ${o.status}`,
      section: 'Orders',
      run: () => router.push(`/dashboard/orders?open=${o.id}`),
      permission: 'order:read',
    }));
    return [...agentCmds, ...orderCmds];
  }, [agents, orders, router]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...baseCommands, ...dynamicCommands].filter(
      (c) => !c.permission || perms.can(c.permission),
    );
    if (!q) return all;
    return all.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.hint || '').toLowerCase().includes(q),
    );
  }, [query, baseCommands, dynamicCommands, perms]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      const cmd = results[cursor];
      if (cmd) {
        cmd.run();
        close();
      }
    }
  }

  if (!open) return null;

  // Group results by section for the dropdown.
  const grouped = new Map<string, Command[]>();
  for (const r of results) {
    const arr = grouped.get(r.section) || [];
    arr.push(r);
    grouped.set(r.section, arr);
  }

  let runningIndex = 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
        zIndex: 80,
      }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <input
          autoFocus
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          style={{
            width: '100%',
            padding: '1rem 1.25rem',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: '0.85rem',
            color: 'var(--fg)',
            borderBottom: '1px solid var(--border)',
          }}
        />
        <div
          style={{
            maxHeight: '55vh',
            overflowY: 'auto',
          }}
        >
          {results.length === 0 ? (
            <div
              style={{
                padding: '1.75rem',
                textAlign: 'center',
                color: 'var(--fg-dim)',
                fontSize: '0.78rem',
              }}
            >
              No commands match &quot;{query}&quot;
            </div>
          ) : (
            Array.from(grouped.entries()).map(([section, cmds]) => (
              <div key={section}>
                <div
                  style={{
                    fontSize: '0.62rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--fg-dim)',
                    padding: '0.6rem 1.25rem 0.35rem',
                  }}
                >
                  {section}
                </div>
                {cmds.map((c) => {
                  const idx = runningIndex++;
                  const active = idx === cursor;
                  return (
                    <button
                      key={c.id}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => {
                        c.run();
                        close();
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        padding: '0.6rem 1.25rem',
                        background: active ? 'var(--surface-hover)' : 'transparent',
                        border: 'none',
                        color: 'var(--fg)',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        textAlign: 'left',
                        gap: '0.75rem',
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.title}
                      </span>
                      {c.hint && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.64rem',
                            color: 'var(--fg-dim)',
                            padding: '0.1rem 0.4rem',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                          }}
                        >
                          {c.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div
          style={{
            padding: '0.55rem 1.25rem',
            fontSize: '0.66rem',
            color: 'var(--fg-dim)',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: '1rem',
          }}
        >
          <span>
            <KbdKey>↑↓</KbdKey> navigate
          </span>
          <span>
            <KbdKey>↵</KbdKey> run
          </span>
          <span>
            <KbdKey>esc</KbdKey> close
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <KbdKey>⌘</KbdKey>
            <KbdKey>K</KbdKey> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

function KbdKey({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        padding: '0.05rem 0.35rem',
        border: '1px solid var(--border)',
        borderRadius: 3,
        background: 'var(--surface-2)',
        marginRight: 3,
      }}
    >
      {children}
    </span>
  );
}
