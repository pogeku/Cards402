import type { Metadata } from 'next';
import { PageHero } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Changelog',
  description:
    'Everything shipped to Cards402. API changes, dashboard polish, security fixes, and upstream-issuer updates — chronologically.',
  alternates: {
    canonical: 'https://cards402.com/changelog',
    // Feed reader auto-discovery: this inserts
    // <link rel="alternate" type="application/rss+xml" href=".../feed.xml">
    // on the changelog head. NetNewsWire, Feedbin, Reeder et al.
    // pick this up when you paste /changelog into "add feed".
    types: {
      'application/rss+xml': 'https://cards402.com/changelog/feed.xml',
    },
  },
  openGraph: ogForPage({
    title: 'Changelog — Cards402',
    description: 'Everything shipped to Cards402, chronologically.',
    path: '/changelog',
  }),
  twitter: twitterForPage({
    title: 'Changelog — Cards402',
    description: 'Everything shipped to Cards402, chronologically.',
  }),
};

type Tag = 'feature' | 'fix' | 'api' | 'security' | 'infra';

const TAG_STYLES: Record<Tag, { color: string; bg: string; border: string }> = {
  feature: {
    color: 'var(--green)',
    bg: 'var(--green-muted)',
    border: 'var(--green-border)',
  },
  fix: {
    color: 'var(--yellow)',
    bg: 'var(--yellow-muted)',
    border: 'var(--yellow-border)',
  },
  api: {
    color: 'var(--blue)',
    bg: 'var(--blue-muted)',
    border: 'var(--blue-border)',
  },
  security: {
    color: 'var(--red)',
    bg: 'var(--red-muted)',
    border: 'var(--red-border)',
  },
  infra: {
    color: 'var(--purple)',
    bg: 'var(--purple-muted)',
    border: 'var(--purple-border)',
  },
};

const ENTRIES: Array<{
  date: string;
  version?: string;
  title: string;
  tags: Tag[];
  body: string;
}> = [
  {
    date: '2026-04-14',
    title: 'Site overhaul: pricing, legal, security, careers',
    tags: ['feature'],
    body: 'New marketing + legal surface. Pricing page with the full Pathward fee breakdown, dedicated Security, Company, Careers, Press, and Affiliate pages. Plain-English cardholder agreement summary. Sitemap, robots, and structured data for search.',
  },
  {
    date: '2026-04-13',
    title: 'Docs redesign & brand polish',
    version: '1.2.0',
    tags: ['feature'],
    body: 'Docs page rewritten onto the Fraunces/IBM Plex type system with editorial section scaffolding. New favicon, Cards402 casing swept across every user-visible surface, notification tray with empty state, login form now submits on Enter.',
  },
  {
    date: '2026-04-13',
    title: 'Email logo visibility on dark background',
    tags: ['fix'],
    body: 'Transactional emails now load a pre-tinted /logo-light.svg variant so the wordmark renders on the dark email template instead of collapsing to an invisible black mask.',
  },
  {
    date: '2026-04-12',
    title: 'Dashboard polish: overflow fixes + microinteractions',
    tags: ['feature'],
    body: 'KPI tile hover lift, row accent on table hover, horizontal scroll hint on borderless cards, theme toggle hides on iPhone-SE-class viewports.',
  },
  {
    date: '2026-04-11',
    title: 'Hero card with parallax tilt',
    tags: ['feature'],
    body: 'New hero section with a lerped-cursor parallax-tilted virtual card and full load-in choreography. Wrap entry, outline draw, glow pulse, fill, content lift, float idle.',
  },
  {
    date: '2026-04-10',
    title: 'Cards402 brand refresh',
    version: '1.1.0',
    tags: ['feature'],
    body: 'New wordmark rendered via CSS mask for theme-aware colouring. Fraunces display + IBM Plex Sans body + IBM Plex Mono data. Darker canvas, muted mint accent, grain overlay, radial glows.',
  },
  {
    date: '2026-04-08',
    title: 'Architecture v2 — agents pay VCC directly',
    version: '1.0.0',
    tags: ['api', 'security'],
    body: 'Non-custodial payment flow: agents now sign and submit Soroban contract invocations directly to the receiver contract. Cards402 proxies the 402 response and observes on-chain events. No funds held in intermediate custody.',
  },
  {
    date: '2026-04-05',
    title: 'First live order on mainnet',
    tags: ['infra'],
    body: 'First end-to-end live order on Stellar mainnet. $0.02 to verify the pipeline, ~33s from payment to PAN. Five watcher bugs found and fixed in the process.',
  },
  {
    date: '2026-04-02',
    title: 'SSE phase stream + waitForCard()',
    tags: ['api', 'feature'],
    body: 'New /orders/:id/stream endpoint pushing order state over Server-Sent Events with a 15-second keepalive comment. SDK waitForCard() defaults to SSE with automatic polling fallback.',
  },
  {
    date: '2026-03-28',
    title: 'Claim-code onboarding',
    tags: ['feature', 'security'],
    body: 'Single-use claim codes replace raw API keys in the agent onboarding flow. Operators mint a claim, share it once, the agent exchanges it for a real key on first boot. Credentials never hit the LLM transcript.',
  },
];

function TagChip({ tag }: { tag: Tag }) {
  const s = TAG_STYLES[tag];
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.62rem',
        fontWeight: 600,
        padding: '0.2rem 0.55rem',
        borderRadius: 999,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        whiteSpace: 'nowrap',
      }}
    >
      {tag}
    </span>
  );
}

export default function ChangelogPage() {
  return (
    <>
      <PageHero
        eyebrow="Changelog"
        title="Everything we've"
        accent="shipped"
        intro="Cards402 is a platform, so every change matters. This page is updated the same day a change lands in production. Security-sensitive fixes are disclosed here after the patch is out. Breaking API changes are always announced 30 days before they take effect."
      />

      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 920,
            margin: '0 auto',
          }}
        >
          {ENTRIES.map((e, i) => (
            <article
              key={e.date + e.title}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 140px) minmax(0, 1fr)',
                gap: '2rem',
                padding: '2.25rem 0',
                borderBottom: i === ENTRIES.length - 1 ? 'none' : '1px solid var(--border)',
              }}
              className="changelog-entry"
            >
              <div>
                <time
                  dateTime={e.date}
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                    color: 'var(--fg)',
                    letterSpacing: '0.01em',
                  }}
                >
                  {new Date(e.date).toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </time>
                {e.version && (
                  <div
                    style={{
                      marginTop: '0.35rem',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--green)',
                    }}
                  >
                    v{e.version}
                  </div>
                )}
              </div>
              <div>
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.45rem',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    margin: '0 0 0.75rem',
                    letterSpacing: '-0.02em',
                    lineHeight: 1.15,
                  }}
                >
                  {e.title}
                </h2>
                <div
                  style={{
                    display: 'flex',
                    gap: '0.45rem',
                    flexWrap: 'wrap',
                    marginBottom: '0.85rem',
                  }}
                >
                  {e.tags.map((t) => (
                    <TagChip key={t} tag={t} />
                  ))}
                </div>
                <p
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.92rem',
                    color: 'var(--fg-muted)',
                    lineHeight: 1.7,
                    margin: 0,
                    maxWidth: 620,
                  }}
                >
                  {e.body}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <style>{`
        @media (max-width: 720px) {
          .changelog-entry {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 0.75rem !important;
          }
        }
      `}</style>
    </>
  );
}
