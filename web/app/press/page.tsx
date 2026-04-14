import type { Metadata } from 'next';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Press',
  description:
    'Press, media, and podcast inquiries for Cards402. Contact, press kit, quick facts, and expert quotes on agent payments.',
  alternates: { canonical: 'https://cards402.com/press' },
  openGraph: ogForPage({
    title: 'Press — Cards402',
    description: 'Press kit, media contact, and expert quotes on autonomous agent payments.',
    path: '/press',
  }),
  twitter: twitterForPage({
    title: 'Press — Cards402',
    description: 'Press kit, media contact, and expert quotes.',
  }),
};

const FACTS = [
  { label: 'Founded', value: '2026' },
  { label: 'Headquarters', value: 'Remote · London' },
  { label: 'Category', value: 'Agent infrastructure' },
  { label: 'Settlement', value: 'Stellar mainnet' },
  { label: 'Issuer', value: 'Pathward, N.A.' },
  { label: 'Funding', value: 'Bootstrapped' },
];

const TOPICS = [
  {
    title: 'Agent payments & x402',
    body: 'How the HTTP 402 pattern is becoming the default for machine-authenticated commerce, and what it unlocks beyond card-not-present fraud.',
  },
  {
    title: 'Non-custodial card issuance',
    body: 'Why agents should pay card networks directly via stablecoins instead of sharing custody with a middleman. Failure modes, design trade-offs, and what it means for regulatory posture.',
  },
  {
    title: 'Stellar for real-world payments',
    body: "Stellar's Soroban smart contracts as a settlement layer for existing rails — stablecoin in, USD out, quoted at order time.",
  },
  {
    title: 'The autonomous agent economy',
    body: 'Practical observations from running live traffic: what agents actually buy, what goes wrong, how long the feedback loop is, and what operators learn from watching programs spend money.',
  },
];

export default function PressPage() {
  return (
    <>
      <PageHero
        eyebrow="Press"
        title="Writing about agent payments? Let's"
        accent="talk"
        intro="Cards402 is one of a small number of teams shipping live infrastructure at the intersection of autonomous agents and traditional card rails. We're happy to do on-the-record interviews, background calls, podcast appearances, and expert quotes for anything in our lane."
      />

      {/* Contact block */}
      <PageSection>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: '3rem',
            alignItems: 'start',
          }}
          className="press-contact-grid"
        >
          <div>
            <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1rem' }}>
              Contact
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.8rem, 3vw + 0.4rem, 2.5rem)',
                color: 'var(--fg)',
                margin: '0 0 1.35rem',
                lineHeight: 1.05,
              }}
            >
              press@cards402.com
            </h2>
            <p
              className="type-body"
              style={{ fontSize: '0.95rem', marginBottom: '1.5rem', maxWidth: 500 }}
            >
              We respond within 24 hours for anything time-sensitive and within three business days
              for everything else. Include your outlet, deadline, and a one-line summary of the
              angle — we&apos;ll come back with the right person.
            </p>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                fontFamily: 'var(--font-body)',
                fontSize: '0.88rem',
                color: 'var(--fg-muted)',
              }}
            >
              <li>
                <strong style={{ color: 'var(--fg)' }}>Interviews.</strong> Video or voice, 30
                minutes. We prefer Riverside but will use whatever your production pipeline uses.
              </li>
              <li>
                <strong style={{ color: 'var(--fg)' }}>Quotes.</strong> Happy to give a paragraph on
                short notice for any piece in our lane — just send the draft context.
              </li>
              <li>
                <strong style={{ color: 'var(--fg)' }}>Podcasts.</strong> Especially anything
                covering AI agents, payments infrastructure, or Stellar.
              </li>
              <li>
                <strong style={{ color: 'var(--fg)' }}>Background.</strong> We&apos;ll talk off the
                record if it helps you get a story right.
              </li>
            </ul>
          </div>

          <div
            style={{
              padding: '2rem 1.85rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 14,
            }}
          >
            <div
              className="type-eyebrow"
              style={{ color: 'var(--fg-dim)', marginBottom: '1.15rem' }}
            >
              Quick facts
            </div>
            <dl
              style={{
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.95rem',
              }}
            >
              {FACTS.map((f) => (
                <div
                  key={f.label}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    paddingBottom: '0.65rem',
                    borderBottom: '1px solid var(--border-hairline)',
                  }}
                >
                  <dt
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--fg-dim)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {f.label}
                  </dt>
                  <dd
                    style={{
                      margin: 0,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.82rem',
                      color: 'var(--fg)',
                      textAlign: 'right',
                    }}
                  >
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </PageSection>

      {/* Topics we cover */}
      <PageSection background="surface" eyebrow="Topics" title="What we can speak to.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '1.35rem',
          }}
        >
          {TOPICS.map((t) => (
            <div
              key={t.title}
              style={{
                padding: '1.8rem 1.65rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 14,
              }}
            >
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.3rem',
                  fontWeight: 500,
                  color: 'var(--fg)',
                  margin: '0 0 0.75rem',
                  letterSpacing: '-0.02em',
                }}
              >
                {t.title}
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
                {t.body}
              </p>
            </div>
          ))}
        </div>
      </PageSection>

      {/* Press kit */}
      <PageSection eyebrow="Press kit" title="Assets, ready to ship.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
            maxWidth: 720,
          }}
        >
          {[
            { label: 'Full wordmark · dark', href: '/logo.svg' },
            { label: 'Full wordmark · light', href: '/logo-light.svg' },
            { label: 'App icon · PNG', href: '/icon.png' },
            { label: 'Apple touch icon · PNG', href: '/apple-icon.png' },
          ].map((a) => (
            <a
              key={a.label}
              href={a.href}
              download
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '1.1rem 1.15rem',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                textDecoration: 'none',
                color: 'var(--fg)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                }}
              >
                {a.label}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                  color: 'var(--green)',
                }}
              >
                ↓
              </span>
            </a>
          ))}
        </div>
        <p
          style={{
            marginTop: '1.75rem',
            fontSize: '0.8rem',
            color: 'var(--fg-dim)',
            maxWidth: 720,
          }}
        >
          Cards402, the Cards402 wordmark, and the Cards402 mark are trademarks of Cards402 Inc. Use
          them to reference us accurately in editorial contexts — don&apos;t modify, recolour, or
          combine them with other marks.
        </p>
      </PageSection>
    </>
  );
}
