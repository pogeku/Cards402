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
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <div className="grain" aria-hidden />
      <nav
        className="marketing-nav"
        style={{
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

      <main id="main" style={{ flex: 1, position: 'relative', zIndex: 2 }}>
        {children}
      </main>

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
              <FooterLink href="/docs/quickstart">Quickstart</FooterLink>
              <FooterLink href="/pricing">Pricing</FooterLink>
              <FooterLink href="/compare">Compare</FooterLink>
              <FooterLink href="/changelog">Changelog</FooterLink>
              <FooterLink href="/blog">Blog</FooterLink>
              <FooterLink href="/dashboard">Dashboard</FooterLink>
            </FooterCol>

            <FooterCol title="Company">
              <FooterLink href="/company">Company</FooterLink>
              <FooterLink href="/careers">Careers</FooterLink>
              <FooterLink href="/press">Press</FooterLink>
              <FooterLink href="/affiliate">Affiliate</FooterLink>
              <FooterLink href="/security">Security</FooterLink>
              <FooterLink href="/status">Status</FooterLink>
            </FooterCol>

            <FooterCol title="Network">
              <FooterLink href="https://stellar.org/" external>
                Stellar
              </FooterLink>
              <FooterLink href="https://www.npmjs.com/package/cards402" external>
                npm · cards402
              </FooterLink>
              <FooterLink href="https://github.com/CTX-com/Cards402" external>
                GitHub
              </FooterLink>
              <FooterLink href="/skill.md">skill.md</FooterLink>
              <FooterLink href="/llms.txt">llms.txt</FooterLink>
            </FooterCol>

            <FooterCol title="Legal">
              <FooterLink href="/terms">Terms</FooterLink>
              <FooterLink href="/privacy">Privacy</FooterLink>
              <FooterLink href="/legal/cardholder-agreement">Cardholder agreement</FooterLink>
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
            <span>
              © {new Date().getFullYear()} Cards402. Cards issued by Pathward, N.A., Member FDIC.
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1.1rem' }}>
              {/* Social icons */}
              <div style={{ display: 'flex', gap: '0.65rem' }}>
                <a
                  href="https://x.com/cards402"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Cards402 on X"
                  style={{
                    color: 'var(--fg-dim)',
                    display: 'inline-flex',
                    transition: 'color 0.3s var(--ease-out)',
                  }}
                  onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) =>
                    (e.currentTarget.style.color = 'var(--fg)')
                  }
                  onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) =>
                    (e.currentTarget.style.color = 'var(--fg-dim)')
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </a>
                <a
                  href="https://github.com/CTX-com/Cards402"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Cards402 on GitHub"
                  style={{
                    color: 'var(--fg-dim)',
                    display: 'inline-flex',
                    transition: 'color 0.3s var(--ease-out)',
                  }}
                  onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) =>
                    (e.currentTarget.style.color = 'var(--fg)')
                  }
                  onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) =>
                    (e.currentTarget.style.color = 'var(--fg-dim)')
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                  </svg>
                </a>
                <a
                  href="/changelog/feed.xml"
                  aria-label="Cards402 changelog RSS feed"
                  style={{
                    color: 'var(--fg-dim)',
                    display: 'inline-flex',
                    transition: 'color 0.3s var(--ease-out)',
                  }}
                  onMouseEnter={(e: MouseEvent<HTMLAnchorElement>) =>
                    (e.currentTarget.style.color = 'var(--fg)')
                  }
                  onMouseLeave={(e: MouseEvent<HTMLAnchorElement>) =>
                    (e.currentTarget.style.color = 'var(--fg-dim)')
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19 7.38 20 6.18 20C5 20 4 19 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27zm0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93z" />
                  </svg>
                </a>
              </div>

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
