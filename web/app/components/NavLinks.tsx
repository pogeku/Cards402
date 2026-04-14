'use client';

// Top marketing nav. Single-level links on the left, a Product menu with
// everything else, plus the primary CTA. On viewports < 720px the menu
// collapses to a hamburger.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { MouseEvent } from 'react';

const PRIMARY: { href: string; label: string }[] = [
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/company', label: 'Company' },
];

const MORE: { href: string; label: string; body: string }[] = [
  { href: '/compare', label: 'Compare', body: 'vs corporate + shared cards' },
  { href: '/security', label: 'Security', body: 'Architecture + disclosure' },
  { href: '/careers', label: 'Careers', body: 'Open roles + benefits' },
  { href: '/press', label: 'Press', body: 'Media kit + contact' },
  { href: '/affiliate', label: 'Affiliate', body: 'Earn on every card · soon' },
];

export function NavLinks() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const linkStyle = (href: string): React.CSSProperties => ({
    textDecoration: 'none',
    color: isActive(href) ? 'var(--fg)' : 'var(--fg-muted)',
    fontSize: '0.84rem',
    fontFamily: 'var(--font-body)',
    fontWeight: 500,
    padding: '0.45rem 0.7rem',
    borderRadius: 6,
    transition: 'color 0.3s var(--ease-out)',
    position: 'relative',
    whiteSpace: 'nowrap',
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.1rem' }}>
      {/* Desktop links */}
      <div className="nav-desktop" style={{ display: 'flex', alignItems: 'center', gap: '0.1rem' }}>
        {PRIMARY.map((l) => (
          <Link key={l.href} href={l.href} style={linkStyle(l.href)}>
            {l.label}
          </Link>
        ))}

        {/* More dropdown */}
        <div
          style={{ position: 'relative' }}
          onMouseEnter={() => setMoreOpen(true)}
          onMouseLeave={() => setMoreOpen(false)}
        >
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-haspopup="true"
            style={{
              ...linkStyle('#'),
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            More
            <svg
              width="10"
              height="10"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden
              style={{
                opacity: 0.6,
                transform: moreOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.3s var(--ease-out)',
              }}
            >
              <path
                d="M3 4.5 6 7.5 9 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {moreOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                // Sit flush against the button with no gap, then use top
                // padding to push the visible card down. The padding is
                // still part of the element's hit area so the mouse never
                // crosses an un-hovered region between the button and the
                // dropdown — which is what was closing it prematurely.
                top: '100%',
                paddingTop: '0.5rem',
                right: 0,
                minWidth: 280,
                zIndex: 60,
              }}
            >
              <div
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  boxShadow: 'var(--shadow-float)',
                  padding: '0.45rem',
                }}
              >
                {MORE.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    style={{
                      display: 'block',
                      padding: '0.65rem 0.75rem',
                      textDecoration: 'none',
                      color: 'var(--fg)',
                      borderRadius: 8,
                      transition: 'background 0.2s var(--ease-out)',
                    }}
                    onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) => {
                      e.currentTarget.style.background = 'var(--surface-hover)';
                    }}
                    onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        color: 'var(--fg)',
                        marginBottom: '0.15rem',
                      }}
                    >
                      {item.label}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: '0.72rem',
                        color: 'var(--fg-dim)',
                      }}
                    >
                      {item.body}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        <Link href="/dashboard" style={{ ...linkStyle('/dashboard'), marginLeft: '0.25rem' }}>
          Dashboard
        </Link>
      </div>

      {/* Primary CTA */}
      <Link
        href="/dashboard"
        className="nav-cta"
        style={{
          marginLeft: '0.6rem',
          textDecoration: 'none',
          fontSize: '0.78rem',
          fontFamily: 'var(--font-body)',
          fontWeight: 600,
          padding: '0.52rem 0.95rem',
          borderRadius: 999,
          background: 'var(--fg)',
          color: 'var(--bg)',
          transition: 'transform 0.3s var(--ease-out), box-shadow 0.3s var(--ease-out)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) => {
          e.currentTarget.style.transform = 'translateY(-1px)';
          e.currentTarget.style.boxShadow = '0 8px 24px -8px var(--green-glow)';
        }}
        onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) => {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        Get started
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden
          style={{ opacity: 0.7, display: 'block' }}
        >
          <path
            d="M2 7h10m-3.5-3.5L12 7l-3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>

      {/* Mobile hamburger */}
      <button
        className="nav-mobile-toggle"
        onClick={() => setMobileOpen((v) => !v)}
        aria-expanded={mobileOpen}
        aria-label="Menu"
        style={{
          display: 'none',
          marginLeft: '0.5rem',
          width: 36,
          height: 36,
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: 'var(--fg)',
          cursor: 'pointer',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d={mobileOpen ? 'M3 3L13 13M13 3L3 13' : 'M2 4h12M2 8h12M2 12h12'}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Mobile sheet */}
      {mobileOpen && (
        <div
          className="nav-mobile-sheet"
          style={{
            position: 'fixed',
            top: 64,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(5,5,5,0.96)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            zIndex: 40,
            padding: '1.5rem 1.35rem',
            overflowY: 'auto',
          }}
          onClick={() => setMobileOpen(false)}
        >
          {[...PRIMARY, ...MORE, { href: '/dashboard', label: 'Dashboard', body: '' }].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              style={{
                display: 'block',
                padding: '1rem 0',
                fontSize: '1.2rem',
                fontFamily: 'var(--font-display)',
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--border)',
              }}
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}

      <style>{`
        @media (max-width: 860px) {
          .nav-desktop { display: none !important; }
          .nav-mobile-toggle { display: inline-flex !important; }
          .nav-cta { display: none !important; }
        }
      `}</style>
    </div>
  );
}
