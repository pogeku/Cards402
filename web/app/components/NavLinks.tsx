'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLinks() {
  const pathname = usePathname();

  const linkStyle = (href: string) => ({
    textDecoration: 'none',
    color: pathname === href ? 'var(--fg)' : 'var(--muted)',
    fontSize: '0.875rem',
    padding: '0.375rem 0.75rem',
    borderRadius: 6,
    background: pathname === href ? 'rgba(255,255,255,0.06)' : 'transparent',
    transition: 'color 0.15s, background 0.15s',
    fontWeight: pathname === href ? 500 : 400,
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
      <Link href="/docs" style={linkStyle('/docs')}>
        Docs
      </Link>
      <Link href="/dashboard" style={linkStyle('/dashboard')}>
        Dashboard
      </Link>
    </div>
  );
}
