import type { Metadata } from 'next';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Affiliate program',
  description:
    'Earn on every Cards402 card issued through your referral. Lifetime tracking, monthly Stellar payouts, white-label dashboard. Coming soon.',
  alternates: { canonical: 'https://cards402.com/affiliate' },
  openGraph: ogForPage({
    title: 'Affiliate program — Cards402',
    description: 'Recurring revenue for referring agent operators. Coming soon.',
    path: '/affiliate',
  }),
  twitter: twitterForPage({
    title: 'Affiliate program — Cards402',
    description: 'Recurring revenue for referring agent operators.',
  }),
};

const PERKS = [
  {
    title: '10% on every card, forever',
    body: 'Earn 10% of every card face-value issued by operators you referred, for the full lifetime of their account. No expiring cookies, no 30-day attribution window, no capped earnings.',
  },
  {
    title: 'Monthly Stellar payouts',
    body: 'Payouts settle directly to your Stellar wallet on the first of every month. USDC by default, XLM if you prefer. One on-chain transaction, auditable in public.',
  },
  {
    title: 'White-label dashboard',
    body: 'Host your own sub-brand of the Cards402 onboarding experience with your logo, your colours, and a custom claim-code flow. Your referrals never see our domain.',
  },
  {
    title: 'Live referral analytics',
    body: 'Track signups, activation rate, card volume, and lifetime value per link in a real-time dashboard. Export everything to CSV for your own reporting.',
  },
];

const IDEAL_FOR = [
  'Agent frameworks (LangChain, LlamaIndex, AutoGPT derivatives)',
  'MCP server registries and directories',
  'LLM workflow platforms integrating spend',
  'Newsletters and technical publications covering autonomous agents',
  'DevTool companies with overlapping ICPs',
  'Venture studios building multiple agent products',
];

export default function AffiliatePage() {
  return (
    <>
      <PageHero
        eyebrow="Affiliate · Coming soon"
        title="Earn when your agents"
        accent="earn"
        intro="We're building a first-class referral program for the platforms and people who bring operators to Cards402. Generous, transparent, lifetime-tracked, paid in stablecoin. Here's what's coming and how to get early access."
      >
        {/* Status pill */}
        <div
          style={{
            marginTop: '2rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.55rem',
            padding: '0.55rem 0.95rem',
            background: 'var(--yellow-muted)',
            border: '1px solid var(--yellow-border)',
            borderRadius: 999,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.72rem',
            color: 'var(--yellow)',
          }}
        >
          <span
            className="pulse-green"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--yellow)',
              animation: 'pulse-green 2s ease-in-out infinite',
            }}
          />
          Launching Q3 2026 · Waitlist open
        </div>
      </PageHero>

      {/* Perks */}
      <PageSection>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '0',
            borderTop: '1px solid var(--border)',
            borderLeft: '1px solid var(--border)',
          }}
        >
          {PERKS.map((p) => (
            <article
              key={p.title}
              style={{
                padding: '2rem 1.85rem 2.35rem',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg)',
              }}
            >
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.4rem',
                  fontWeight: 500,
                  letterSpacing: '-0.02em',
                  color: 'var(--fg)',
                  margin: '0 0 0.95rem',
                  lineHeight: 1.12,
                }}
              >
                {p.title}
              </h3>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.88rem',
                  color: 'var(--fg-muted)',
                  lineHeight: 1.65,
                  margin: 0,
                }}
              >
                {p.body}
              </p>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Ideal for */}
      <PageSection background="surface" eyebrow="Good fit" title="Who we're building this for.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '0.9rem',
            maxWidth: 920,
          }}
        >
          {IDEAL_FOR.map((x) => (
            <div
              key={x}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.7rem',
                padding: '0.95rem 1.1rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 10,
              }}
            >
              <span
                aria-hidden
                style={{
                  color: 'var(--green)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                }}
              >
                →
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.86rem',
                  color: 'var(--fg-muted)',
                  lineHeight: 1.5,
                }}
              >
                {x}
              </span>
            </div>
          ))}
        </div>
      </PageSection>

      {/* Waitlist CTA */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 760,
            margin: '0 auto',
            padding: '3rem 2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--green-border)',
            borderRadius: 16,
            position: 'relative',
            overflow: 'hidden',
            textAlign: 'center',
          }}
        >
          <div className="radial-green-glow" aria-hidden style={{ opacity: 0.2 }} />
          <div style={{ position: 'relative' }}>
            <div
              className="type-eyebrow"
              style={{ color: 'var(--green)', marginBottom: '0.95rem' }}
            >
              Early access
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.7rem, 3vw + 0.5rem, 2.4rem)',
                color: 'var(--fg)',
                margin: '0 auto 1.35rem',
                maxWidth: 560,
              }}
            >
              First 20 affiliates get a lifetime 15% rate.
            </h2>
            <p
              className="type-body"
              style={{ fontSize: '0.92rem', maxWidth: 480, margin: '0 auto 1.85rem' }}
            >
              Email{' '}
              <a
                href="mailto:affiliate@cards402.com?subject=Affiliate waitlist"
                style={{
                  color: 'var(--fg)',
                  borderBottom: '1px solid var(--green-border)',
                  textDecoration: 'none',
                }}
              >
                affiliate@cards402.com
              </a>{' '}
              with a link to your platform or audience. We&apos;ll reply within a week with next
              steps and your provisional slot.
            </p>
            <a
              href="mailto:affiliate@cards402.com?subject=Affiliate waitlist"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.55rem',
                padding: '0.85rem 1.35rem',
                borderRadius: 999,
                background: 'var(--fg)',
                color: 'var(--bg)',
                textDecoration: 'none',
                fontSize: '0.88rem',
                fontWeight: 600,
              }}
            >
              Join the waitlist →
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
