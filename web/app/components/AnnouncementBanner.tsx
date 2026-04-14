'use client';

// Reusable top-of-nav announcement banner. Accepts a unique `id` so
// dismissals are remembered in localStorage — bumping the id ships a
// new announcement. Tone defaults to "info" (mint accent); pass
// tone="warning" for incidents or "muted" for soft launches.
//
// Usage (call site supplies the copy):
//
//   <AnnouncementBanner id="2026-Q2-live-metrics" href="/changelog">
//     Live metrics are now on the landing page
//   </AnnouncementBanner>
//
// Kept out of MarketingChrome by default so every render doesn't
// ship announcement state unconditionally. Mount the component in
// layout.tsx or MarketingChrome when you actually have something to
// announce.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ReactNode } from 'react';

type Tone = 'info' | 'warning' | 'muted';

interface Props {
  // Stable dismissal key. Bump to re-show after user dismissed.
  id: string;
  href?: string;
  tone?: Tone;
  children: ReactNode;
}

const TONE_STYLES: Record<Tone, { bg: string; border: string; dot: string; text: string }> = {
  info: {
    bg: 'var(--green-muted)',
    border: 'var(--green-border)',
    dot: 'var(--green)',
    text: 'var(--fg)',
  },
  warning: {
    bg: 'var(--yellow-muted)',
    border: 'var(--yellow-border)',
    dot: 'var(--yellow)',
    text: 'var(--fg)',
  },
  muted: {
    bg: 'var(--surface)',
    border: 'var(--border)',
    dot: 'var(--fg-dim)',
    text: 'var(--fg-muted)',
  },
};

export function AnnouncementBanner({ id, href, tone = 'info', children }: Props) {
  const storageKey = `cards402.announcement.dismissed.${id}`;
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  // Resolve the dismissed state after mount so SSR markup is stable.
  // Returning null on the server side would mismatch React's
  // hydration; we intentionally render the banner by default and
  // hide it client-side if the storage says otherwise.
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(storageKey) === '1');
    } catch {
      setDismissed(false);
    }
  }, [storageKey]);

  // Don't render until we've resolved dismissal, to avoid the
  // flicker where the banner flashes visible then disappears.
  if (dismissed === null || dismissed === true) return null;

  const s = TONE_STYLES[tone];

  const Inner = (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        flex: 1,
        minWidth: 0,
      }}
    >
      <span
        className="pulse-green"
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: s.dot,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: '0.82rem',
          color: s.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      {href && (
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            color: s.dot,
            marginLeft: '0.35rem',
          }}
        >
          →
        </span>
      )}
    </span>
  );

  return (
    <div
      role="status"
      style={{
        background: s.bg,
        borderBottom: `1px solid ${s.border}`,
        position: 'relative',
        zIndex: 49,
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          padding: '0.55rem 1.35rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        {href ? (
          <Link
            href={href}
            style={{
              textDecoration: 'none',
              display: 'flex',
              flex: 1,
              minWidth: 0,
            }}
          >
            {Inner}
          </Link>
        ) : (
          Inner
        )}
        <button
          onClick={() => {
            try {
              window.localStorage.setItem(storageKey, '1');
            } catch {
              /* non-critical */
            }
            setDismissed(true);
          }}
          aria-label="Dismiss announcement"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: s.text,
            opacity: 0.65,
            padding: '0.25rem 0.35rem',
            lineHeight: 1,
            fontSize: '1rem',
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
