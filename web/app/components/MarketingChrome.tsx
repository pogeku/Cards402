// Wraps the marketing nav + footer. Returns null on /dashboard routes
// so the dashboard can own its own chrome. Lets the root layout stay
// a server component.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavLinks } from './NavLinks';
import type { ReactNode } from 'react';

function StellarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-label="Stellar">
      <path
        d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function USDCIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-label="USDC">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 7v1.5M12 15.5V17M9 12h6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MarketingChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hideChrome = pathname.startsWith('/dashboard');

  if (hideChrome) {
    return <>{children}</>;
  }

  return (
    <>
      <nav
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'rgba(10,10,10,0.97)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            padding: '0 1.5rem',
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Link
            href="/"
            style={{
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '1rem',
                fontWeight: 700,
                color: 'var(--fg)',
                letterSpacing: '-0.02em',
              }}
            >
              cards<span style={{ color: 'var(--green)' }}>402</span>
            </span>
          </Link>
          <NavLinks />
        </div>
      </nav>

      <main style={{ flex: 1 }}>{children}</main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '1.5rem' }}>
        <div
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
              color: 'var(--muted)',
              fontWeight: 600,
            }}
          >
            cards<span style={{ color: 'var(--green)' }}>402</span>.com
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                color: 'var(--muted)',
                fontSize: '0.8125rem',
              }}
            >
              <StellarIcon />
              Stellar
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                color: 'var(--muted)',
                fontSize: '0.8125rem',
              }}
            >
              <USDCIcon />
              USDC
            </span>
            <Link
              href="/agents.txt"
              style={{
                color: 'var(--muted)',
                fontSize: '0.8125rem',
                textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
              }}
            >
              agents.txt
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
