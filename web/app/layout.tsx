import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import Link from 'next/link';
import { NavLinks } from '@/app/components/NavLinks';
import './globals.css';

// Local font — no network fetch at build time
const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: 'cards402 — Virtual cards for AI agents',
  description:
    'Pay USDC or XLM on Stellar. Get a Visa card number in ~60 seconds. No signup. No KYC. No fees.',
  openGraph: {
    title: 'cards402 — Virtual cards for AI agents',
    description: 'Pay USDC or XLM on Stellar. Get a Visa card number in ~60 seconds.',
    url: 'https://cards402.com',
  },
};

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body
        style={{
          background: 'var(--bg)',
          color: 'var(--fg)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          margin: 0,
        }}
      >
        {/* Nav */}
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
            {/* Logo */}
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
                cards
                <span style={{ color: 'var(--green)' }}>402</span>
              </span>
            </Link>

            <NavLinks />
          </div>
        </nav>

        {/* Main content */}
        <main style={{ flex: 1 }}>{children}</main>

        {/* Footer */}
        <footer
          style={{
            borderTop: '1px solid var(--border)',
            padding: '1.5rem',
          }}
        >
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
      </body>
    </html>
  );
}
