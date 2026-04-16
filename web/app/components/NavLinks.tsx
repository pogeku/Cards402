'use client';

// Top marketing nav — a single responsive menu that renders as a
// horizontal bar on desktop (>860px) and collapses to a hamburger
// with a fullscreen sheet on mobile. Links are rendered once; CSS
// handles the layout switch.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

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
  const [menuOpen, setMenuOpen] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement>(null);

  // ESC closes any open menu.
  useEffect(() => {
    if (!moreOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen, menuOpen]);

  // Click outside closes the More dropdown. Only wired while open.
  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: globalThis.MouseEvent) => {
      if (!moreWrapRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [moreOpen]);

  // Route change closes everything.
  useEffect(() => {
    setMoreOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // Lock page scroll while the mobile menu is open. Both html and body
  // need overflow:hidden — iOS Safari ignores it on body alone.
  useEffect(() => {
    if (!menuOpen) return;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.1rem' }}>
      {/* Single nav menu — row on desktop, fullscreen column on mobile */}
      <div
        className={`nav-menu${menuOpen ? ' nav-menu--open' : ''}`}
        onClick={() => setMenuOpen(false)}
      >
        {PRIMARY.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="nav-menu-link"
            data-active={isActive(l.href) || undefined}
          >
            {l.label}
          </Link>
        ))}

        {/* More — dropdown on desktop, items flow inline on mobile */}
        <div
          ref={moreWrapRef}
          className="nav-more"
          onMouseEnter={() => setMoreOpen(true)}
          onMouseLeave={() => setMoreOpen(false)}
        >
          <button
            className="nav-more-btn"
            onClick={() => setMoreOpen(true)}
            aria-expanded={moreOpen}
            aria-haspopup="true"
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
          <div className={`nav-more-dropdown${moreOpen ? ' nav-more-dropdown--open' : ''}`}>
            <div className="nav-more-dropdown-card">
              {MORE.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="nav-more-item"
                  data-active={isActive(item.href) || undefined}
                  onClick={() => setMoreOpen(false)}
                >
                  <div className="nav-more-item-label">{item.label}</div>
                  <div className="nav-more-item-body">{item.body}</div>
                </Link>
              ))}
            </div>
          </div>
        </div>

        <Link
          href="/dashboard"
          className="nav-menu-link nav-menu-link--dashboard"
          data-active={isActive('/dashboard') || undefined}
        >
          Dashboard
        </Link>
      </div>

      {/* Primary CTA */}
      <Link href="/dashboard" className="nav-cta">
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

      {/* Hamburger — visible only on mobile */}
      <button
        className="nav-toggle"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        aria-label="Menu"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d={menuOpen ? 'M3 3L13 13M13 3L3 13' : 'M2 4h12M2 8h12M2 12h12'}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <style>{`
        /* Pseudo-element carries the nav's backdrop so the <nav> itself
           doesn't create a containing block for position:fixed children
           (the mobile menu). Background + border live here too. */
        .marketing-nav::before {
          content: '';
          position: absolute;
          inset: 0;
          z-index: -1;
          background: rgba(5,5,5,0.72);
          backdrop-filter: blur(16px) saturate(140%);
          -webkit-backdrop-filter: blur(16px) saturate(140%);
          border-bottom: 1px solid var(--border);
        }

        /* ---- Desktop (default) ---- */
        .nav-menu {
          display: flex;
          align-items: center;
          gap: 0.1rem;
        }
        .nav-menu-link {
          text-decoration: none;
          color: var(--fg-muted);
          font-size: 0.84rem;
          font-family: var(--font-body);
          font-weight: 500;
          padding: 0.45rem 0.7rem;
          border-radius: 6px;
          transition: color 0.3s var(--ease-out);
          white-space: nowrap;
        }
        .nav-menu-link[data-active] { color: var(--fg); }
        .nav-menu-link--dashboard { margin-left: 0.25rem; }

        .nav-more { position: relative; }
        .nav-more-btn {
          color: var(--fg-muted);
          font-size: 0.84rem;
          font-family: var(--font-body);
          font-weight: 500;
          padding: 0.45rem 0.7rem;
          border-radius: 6px;
          transition: color 0.3s var(--ease-out);
          white-space: nowrap;
          background: transparent;
          border: none;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
        }
        .nav-more-dropdown {
          display: none;
          position: absolute;
          top: 100%;
          padding-top: 0.5rem;
          right: 0;
          min-width: 280px;
          z-index: 60;
        }
        .nav-more-dropdown--open { display: block; }
        .nav-more-dropdown-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: var(--shadow-float);
          padding: 0.45rem;
        }
        .nav-more-item {
          display: block;
          padding: 0.65rem 0.75rem;
          text-decoration: none;
          color: var(--fg);
          border-radius: 8px;
          transition: background 0.2s var(--ease-out);
        }
        .nav-more-item:hover { background: var(--surface-hover); }
        .nav-more-item-label {
          font-family: var(--font-body);
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--fg);
          margin-bottom: 0.15rem;
        }
        .nav-more-item-body {
          font-family: var(--font-body);
          font-size: 0.72rem;
          color: var(--fg-dim);
        }

        .nav-cta {
          margin-left: 0.6rem;
          text-decoration: none;
          font-size: 0.78rem;
          font-family: var(--font-body);
          font-weight: 600;
          padding: 0.52rem 0.95rem;
          border-radius: 999px;
          background: var(--fg);
          color: var(--bg);
          transition: transform 0.3s var(--ease-out), box-shadow 0.3s var(--ease-out);
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          white-space: nowrap;
        }
        .nav-cta:hover {
          transform: translateY(-1px);
          box-shadow: 0 8px 24px -8px var(--green-glow);
        }

        .nav-toggle {
          display: none;
          margin-left: 0.5rem;
          width: 36px;
          height: 36px;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--fg);
          cursor: pointer;
        }

        /* ---- Mobile (≤ 860px) ---- */
        @media (max-width: 860px) {
          .nav-toggle { display: inline-flex; }
          .nav-cta { display: none; }

          .nav-menu {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            height: calc(100vh - 64px);
            height: calc(100dvh - 64px);
            flex-direction: column;
            align-items: stretch;
            background: rgba(5,5,5,0.96);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            z-index: 40;
            padding: 1.5rem 1.35rem;
            overflow-y: auto;
            overscroll-behavior: contain;
          }
          .nav-menu--open { display: flex; }

          .nav-menu-link {
            padding: 1rem 0;
            font-size: 1.2rem;
            font-family: var(--font-display);
            color: var(--fg);
            border-bottom: 1px solid var(--border);
            border-radius: 0;
            white-space: normal;
          }
          .nav-menu-link--dashboard { margin-left: 0; }

          /* Flatten the More wrapper so its items flow in the column */
          .nav-more { display: contents; }
          .nav-more-btn { display: none; }
          .nav-more-dropdown { display: contents !important; }
          .nav-more-dropdown-card { display: contents; }
          .nav-more-item {
            padding: 1rem 0;
            font-size: 1.2rem;
            font-family: var(--font-display);
            color: var(--fg);
            border-bottom: 1px solid var(--border);
            border-radius: 0;
          }
          .nav-more-item:hover { background: transparent; }
          .nav-more-item-label {
            font-size: inherit;
            font-family: inherit;
            margin-bottom: 0;
          }
          .nav-more-item-body { display: none; }
        }
      `}</style>
    </div>
  );
}
