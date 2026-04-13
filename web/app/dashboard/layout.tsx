// Dashboard shell — sidebar + header + content area + toast provider.
// The root layout checks usePathname and hides marketing nav/footer
// for any /dashboard path, so this layout fills the full viewport.
//
// Auth gating: the DashboardProvider fetches /api/auth/me on mount and
// exposes { user, authError, loading } to children. The AuthGate below
// shows a minimal sign-in splash when not authenticated — full OTP
// flow lives in the _auth module and is re-used by the legacy page
// until everything is migrated.

'use client';

import type { ReactNode } from 'react';
import { DashboardProvider, useDashboard } from './_lib/DashboardProvider';
import { ToastProvider } from './_ui/Toast';
import { Sidebar } from './_shell/Sidebar';
import { Header } from './_shell/Header';
import { AuthGate } from './_shell/AuthGate';
import { FeedbackLauncher } from './_shell/FeedbackLauncher';
import { CommandPalette } from './_shell/CommandPalette';

function ShellInner({ children }: { children: ReactNode }) {
  const { loading, authError } = useDashboard();

  if (loading) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
          color: 'var(--fg-dim)',
          fontSize: '0.85rem',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Loading…
      </div>
    );
  }

  if (authError) {
    return <AuthGate />;
  }

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Header />
        <main style={{ flex: 1, overflowY: 'auto' }}>{children}</main>
      </div>
      <FeedbackLauncher />
      <CommandPalette />
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardProvider>
      <ToastProvider>
        <ShellInner>{children}</ShellInner>
      </ToastProvider>
    </DashboardProvider>
  );
}
