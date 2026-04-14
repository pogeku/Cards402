import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Engineering-honest writing from the Cards402 team. Architecture, incidents, and what we learned building payment rails for AI agents.',
  alternates: { canonical: 'https://cards402.com/blog' },
  openGraph: ogForPage({
    title: 'Blog — Cards402',
    description:
      'Engineering-honest writing from the Cards402 team. Architecture, incidents, and what we learned building payment rails for AI agents.',
    path: '/blog',
  }),
  twitter: twitterForPage({
    title: 'Blog — Cards402',
    description: 'Engineering-honest writing from the Cards402 team.',
  }),
};

// Published posts (the few that are live) followed by the pipeline
// of drafts. Each entry has a `slug` when it's shipped, in which
// case the title links out to the full post; drafts leave `slug`
// undefined and render as plain rows.
type Post = {
  date: string;
  title: string;
  excerpt: string;
  tags: string[];
  slug?: string;
};

const PUBLISHED: Post[] = [
  {
    date: '2026-04-14',
    slug: 'anatomy-of-a-cards402-order',
    title: 'Anatomy of a Cards402 order',
    excerpt:
      'Every millisecond of the 33-second path from agent.purchaseCard() to PAN-in-hand. Payment confirmation, Stage 1 scrape, Stage 2 fulfilment, the SSE stream, and the failure modes we found along the way.',
    tags: ['engineering', 'fulfilment'],
  },
];

const PIPELINE: Post[] = [
  {
    date: 'Coming soon',
    title: 'How we built non-custodial card issuance on Soroban',
    excerpt:
      'Architecture walkthrough of the Cards402 receiver contract, the Stellar watcher, and the fulfilment pipeline. Why agents pay the contract directly and what it takes to keep the backend from ever touching a customer wallet.',
    tags: ['architecture', 'stellar'],
  },
  {
    date: 'Coming soon',
    title: 'Why SSE beats polling for agent-facing APIs',
    excerpt:
      'Server-Sent Events are almost always the right primitive for long-lived order tracking with autonomous clients. Latency, reconnection behaviour, and why the cards402 SDK uses SSE-first with polling as an automatic fallback.',
    tags: ['api', 'engineering'],
  },
  {
    date: 'Coming soon',
    title: 'Claim codes: credentials that never touch the transcript',
    excerpt:
      'Why we chose single-use claim codes instead of raw API keys for agent onboarding, the threat model we were optimising for, and how the exchange flow avoids every credential-in-prompt failure mode we could think of.',
    tags: ['security'],
  },
];

export default function BlogIndexPage() {
  return (
    <>
      <PageHero
        eyebrow="Blog"
        title="Engineering honest writing from the"
        accent="team"
        intro="We don’t do content marketing. When we publish, it’s because we built something interesting or shipped something worth understanding. Every post cross-posts to the changelog RSS."
      />

      {/* Published posts */}
      <PageSection eyebrow="Published" title="Posts.">
        <div
          style={{
            display: 'grid',
            gap: '0',
            borderTop: '1px solid var(--border)',
          }}
        >
          {PUBLISHED.map((p) => (
            <article
              key={p.title}
              style={{
                padding: '2rem 0',
                borderBottom: '1px solid var(--border)',
                display: 'grid',
                gridTemplateColumns: 'minmax(110px, 130px) minmax(0, 1fr)',
                gap: '2rem',
                alignItems: 'baseline',
              }}
              className="blog-pipeline-row"
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.68rem',
                  color: 'var(--fg-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                }}
              >
                <time dateTime={p.date}>
                  {new Date(p.date).toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </time>
              </div>
              <div>
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.3rem, 2vw + 0.3rem, 1.8rem)',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    margin: '0 0 0.7rem',
                    letterSpacing: '-0.02em',
                    lineHeight: 1.15,
                  }}
                >
                  <Link
                    href={`/blog/${p.slug}`}
                    style={{
                      color: 'var(--fg)',
                      textDecoration: 'none',
                      transition: 'color 0.3s var(--ease-out)',
                    }}
                    className="blog-post-title"
                  >
                    {p.title} →
                  </Link>
                </h2>
                <p
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.9rem',
                    color: 'var(--fg-muted)',
                    lineHeight: 1.68,
                    margin: '0 0 0.85rem',
                    maxWidth: 620,
                  }}
                >
                  {p.excerpt}
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: '0.4rem',
                    flexWrap: 'wrap',
                  }}
                >
                  {p.tags.map((t) => (
                    <span
                      key={t}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.6rem',
                        padding: '0.2rem 0.55rem',
                        borderRadius: 999,
                        color: 'var(--fg-dim)',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Pipeline */}
      <PageSection eyebrow="Pipeline" title="What's on deck.">
        <div
          style={{
            display: 'grid',
            gap: '0',
            borderTop: '1px solid var(--border)',
          }}
        >
          {PIPELINE.map((p) => (
            <article
              key={p.title}
              style={{
                padding: '2rem 0',
                borderBottom: '1px solid var(--border)',
                display: 'grid',
                gridTemplateColumns: 'minmax(110px, 130px) minmax(0, 1fr)',
                gap: '2rem',
                alignItems: 'baseline',
              }}
              className="blog-pipeline-row"
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.68rem',
                  color: 'var(--fg-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                }}
              >
                {p.date}
              </div>
              <div>
                <h2
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.3rem, 2vw + 0.3rem, 1.8rem)',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    margin: '0 0 0.7rem',
                    letterSpacing: '-0.02em',
                    lineHeight: 1.15,
                  }}
                >
                  {p.title}
                </h2>
                <p
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.9rem',
                    color: 'var(--fg-muted)',
                    lineHeight: 1.68,
                    margin: '0 0 0.85rem',
                    maxWidth: 620,
                  }}
                >
                  {p.excerpt}
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: '0.4rem',
                    flexWrap: 'wrap',
                  }}
                >
                  {p.tags.map((t) => (
                    <span
                      key={t}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.6rem',
                        padding: '0.2rem 0.55rem',
                        borderRadius: 999,
                        color: 'var(--fg-dim)',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Pitch */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 760,
            margin: '0 auto',
            padding: '2.5rem 2.25rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 14,
          }}
        >
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '0.85rem' }}>
            Want to write for us?
          </div>
          <h2
            className="type-display-tight"
            style={{
              fontSize: 'clamp(1.5rem, 2.6vw + 0.4rem, 2rem)',
              color: 'var(--fg)',
              margin: '0 0 1.15rem',
              maxWidth: 580,
            }}
          >
            Technical guest posts welcome.
          </h2>
          <p
            className="type-body"
            style={{ fontSize: '0.92rem', marginBottom: '1.2rem', maxWidth: 620 }}
          >
            If you&apos;ve built something interesting on top of Cards402 and want to write about
            it, we&apos;ll happily host it on the blog with full byline and a link to your work.
            Email{' '}
            <a
              href="mailto:press@cards402.com"
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--green-border)',
              }}
            >
              press@cards402.com
            </a>{' '}
            with a rough outline or a draft.
          </p>
        </div>
      </section>

      <style>{`
        .blog-post-title:hover {
          color: var(--green);
        }
        @media (max-width: 720px) {
          .blog-pipeline-row {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 0.75rem !important;
          }
        }
      `}</style>
    </>
  );
}
