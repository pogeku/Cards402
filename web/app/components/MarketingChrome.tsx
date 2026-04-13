// Marketing chrome — sticky nav with the Cards402 wordmark, plus a
// footer with the same wordmark at a smaller size. Returns null on
// /dashboard routes so the dashboard can own its own chrome. The root
// layout stays a server component; this client component is only
// responsible for the pathname check + the interactive bits.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavLinks } from './NavLinks';
import { Wordmark } from './Wordmark';
import type { MouseEvent, ReactNode } from 'react';

export function MarketingChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hideChrome = pathname.startsWith('/dashboard');

  if (hideChrome) {
    return <>{children}</>;
  }

  return (
    <>
      <div className="grain" aria-hidden />
      <nav
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'rgba(5,5,5,0.72)',
          backdropFilter: 'blur(16px) saturate(140%)',
          WebkitBackdropFilter: 'blur(16px) saturate(140%)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            padding: '0 1.35rem',
            height: 64,
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
              gap: '0.6rem',
              color: 'var(--fg)',
              // Transition the logo color on hover as a subtle cue.
              transition: 'color 0.4s var(--ease-out)',
            }}
            onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) =>
              (e.currentTarget.style.color = 'var(--green)')
            }
            onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) =>
              (e.currentTarget.style.color = 'var(--fg)')
            }
          >
            <Wordmark height={22} />
          </Link>
          <NavLinks />
        </div>
      </nav>

      <main style={{ flex: 1, position: 'relative', zIndex: 2 }}>{children}</main>

      <footer
        style={{
          borderTop: '1px solid var(--border)',
          padding: '3.5rem 1.35rem 2.25rem',
          marginTop: '6rem',
          position: 'relative',
          zIndex: 2,
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '2.5rem',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '2rem',
              alignItems: 'start',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <Wordmark height={20} />
              <p
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--fg-dim)',
                  lineHeight: 1.6,
                  maxWidth: 260,
                  margin: 0,
                }}
              >
                Virtual Visa cards for AI agents. One Stellar transaction in, one real card out.
              </p>
            </div>

            <FooterCol title="Product">
              <FooterLink href="/docs">Docs</FooterLink>
              <FooterLink href="/dashboard">Dashboard</FooterLink>
              <FooterLink href="/agents.txt">agents.txt</FooterLink>
              <FooterLink href="/skill.md">skill.md</FooterLink>
            </FooterCol>

            <FooterCol title="Network">
              <FooterLink href="https://stellar.expert/" external>
                Stellar
              </FooterLink>
              <FooterLink href="https://www.npmjs.com/package/cards402" external>
                npm · cards402
              </FooterLink>
              <FooterLink href="https://github.com/CTX-com/Cards402" external>
                GitHub
              </FooterLink>
            </FooterCol>

            <FooterCol title="Legal">
              <FooterLink href="/terms">Terms</FooterLink>
              <FooterLink href="/privacy">Privacy</FooterLink>
            </FooterCol>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '1.5rem',
              borderTop: '1px solid var(--border)',
              fontSize: '0.72rem',
              color: 'var(--fg-dim)',
              fontFamily: 'var(--font-mono)',
              flexWrap: 'wrap',
              gap: '0.75rem',
            }}
          >
            <span>© {new Date().getFullYear()} Cards402</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span
                className="pulse-green"
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--green)',
                  boxShadow: '0 0 10px var(--green-glow)',
                }}
              />
              Live on Stellar mainnet
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      <div className="type-eyebrow" style={{ fontSize: '0.64rem', color: 'var(--fg-dim)' }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>{children}</div>
    </div>
  );
}

function FooterLink({
  href,
  children,
  external,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      style={{
        color: 'var(--fg-muted)',
        textDecoration: 'none',
        fontSize: '0.82rem',
        fontFamily: 'var(--font-body)',
        transition: 'color 0.3s var(--ease-out)',
        display: 'inline-block',
        width: 'fit-content',
      }}
      onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) =>
        (e.currentTarget.style.color = 'var(--fg)')
      }
      onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) =>
        (e.currentTarget.style.color = 'var(--fg-muted)')
      }
    >
      {children}
    </Link>
  );
}
