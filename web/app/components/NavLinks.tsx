'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MouseEvent } from 'react';

export function NavLinks() {
  const pathname = usePathname();

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
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.1rem' }}>
      <Link href="/docs" style={linkStyle('/docs')}>
        Docs
      </Link>
      <Link href="/dashboard" style={linkStyle('/dashboard')}>
        Dashboard
      </Link>
      <Link
        href="/dashboard"
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
    </div>
  );
}
