// Top bar: global search, live indicator, notifications bell, theme
// toggle, avatar with dropdown. Most controls are stubs wired to the
// DashboardProvider or local state; full behavior lands in Phase 1
// polish pass.

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../_lib/DashboardProvider';
import { applyTheme, loadTheme, saveTheme, type Theme } from '../_ui/theme';
import { logout } from '../_lib/api';
import { GlobalSearch } from './GlobalSearch';

function SvgIcon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

export function Header() {
  const { user, info, approvals } = useDashboard();
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>('dark');
  const [avatarOpen, setAvatarOpen] = useState(false);

  // Theme: load saved on mount, listen for system change in system mode.
  useEffect(() => {
    const initial = loadTheme();
    setTheme(initial);
    applyTheme(initial);
    if (initial !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  function cycleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  }

  async function handleLogout() {
    await logout();
    router.push('/');
  }

  const pendingApprovals = approvals.length;
  const isPlatformOwner = !!user?.is_platform_owner;
  // Regular users should never see the platform-level "frozen" state —
  // that's a cards402 operator concern (the tenant circuit breaker).
  // Non-owners always see "Live" as long as they can load the page;
  // if the API is really down, the dashboard wouldn't render at all.
  const systemHealthy = isPlatformOwner ? (info ? !info.frozen : true) : true;

  return (
    <header
      className="dashboard-header"
      style={{
        height: 52,
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0 1rem',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, maxWidth: 320 }}>
        <GlobalSearch />
      </div>

      <div style={{ flex: 1 }} />

      {/* Live indicator. Non-owners always see "Live"; platform owners
          see "Frozen" when the fulfillment circuit breaker trips. */}
      <div
        className="dashboard-header-live"
        title={systemHealthy ? (isPlatformOwner ? 'Live — mainnet' : 'Live') : 'Fulfillment frozen'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.25rem 0.55rem',
          border: `1px solid ${systemHealthy ? 'var(--green-border)' : 'var(--red-border)'}`,
          background: systemHealthy ? 'var(--green-muted)' : 'var(--red-muted)',
          borderRadius: 999,
          fontSize: '0.7rem',
          fontFamily: 'var(--font-mono)',
          color: systemHealthy ? 'var(--green)' : 'var(--red)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: systemHealthy ? 'var(--green)' : 'var(--red)',
            animation: systemHealthy ? 'pulse 2s ease-in-out infinite' : undefined,
          }}
        />
        {systemHealthy ? 'Live' : 'Frozen'}
      </div>

      {/* Theme toggle — hidden on iPhone-SE-class viewports to make
          room for the live pill, bell, and avatar. Theme preference
          persists in localStorage so users only need to set it once. */}
      <button
        onClick={cycleTheme}
        title={`Theme: ${theme}`}
        className="dashboard-header-theme"
        style={{
          width: 32,
          height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {theme === 'light' ? (
          <SvgIcon d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        ) : theme === 'dark' ? (
          <SvgIcon d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        ) : (
          <SvgIcon d="M12 3v18M3 12h18" />
        )}
      </button>

      {/* Notifications bell */}
      <button
        title={pendingApprovals ? `${pendingApprovals} pending approvals` : 'No pending approvals'}
        style={{
          position: 'relative',
          width: 32,
          height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <SvgIcon d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        {pendingApprovals > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 14,
              height: 14,
              padding: '0 3px',
              borderRadius: 7,
              background: 'var(--red)',
              color: '#000',
              fontSize: '0.58rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {pendingApprovals}
          </span>
        )}
      </button>

      {/* Avatar / menu */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={() => setAvatarOpen((v) => !v)}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'var(--green-muted)',
            border: '1px solid var(--green-border)',
            color: 'var(--green)',
            fontSize: '0.72rem',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {user?.email?.[0]?.toUpperCase() || '?'}
        </button>
        {avatarOpen && (
          <div
            style={{
              position: 'absolute',
              top: 40,
              right: 0,
              minWidth: 200,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: 'var(--shadow-card)',
              padding: '0.35rem',
              zIndex: 30,
            }}
          >
            <div
              style={{
                padding: '0.55rem 0.7rem',
                fontSize: '0.72rem',
                color: 'var(--fg-dim)',
                borderBottom: '1px solid var(--border)',
                marginBottom: '0.25rem',
              }}
            >
              {user?.email || 'signed out'}
            </div>
            <button
              onClick={handleLogout}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.7rem',
                background: 'transparent',
                border: 'none',
                color: 'var(--fg)',
                fontSize: '0.75rem',
                cursor: 'pointer',
                borderRadius: 4,
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
