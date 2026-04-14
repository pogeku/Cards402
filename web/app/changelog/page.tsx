import type { Metadata } from 'next';
import { PageHero } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';
import { CHANGELOG_ENTRIES as ENTRIES, type ChangelogTag as Tag } from './entries';

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

// BlogPosting ItemList — each changelog entry as a structured
// posting. Google treats this as an index of time-stamped updates
// even though they all share the /changelog URL. Anchors are hash
// fragments onto the same page.
function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const changelogJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  itemListElement: ENTRIES.map((e, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'BlogPosting',
      headline: e.version ? `v${e.version} — ${e.title}` : e.title,
      datePublished: e.date,
      description: e.body,
      url: `https://cards402.com/changelog#${e.date}-${slug(e.title)}`,
      author: { '@type': 'Organization', name: 'Cards402' },
      publisher: {
        '@type': 'Organization',
        name: 'Cards402',
        logo: {
          '@type': 'ImageObject',
          url: 'https://cards402.com/icon.png',
        },
      },
    },
  })),
};

export default function ChangelogPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(changelogJsonLd) }}
      />
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
              id={`${e.date}-${slug(e.title)}`}
              key={e.date + e.title}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 140px) minmax(0, 1fr)',
                gap: '2rem',
                padding: '2.25rem 0',
                borderBottom: i === ENTRIES.length - 1 ? 'none' : '1px solid var(--border)',
                scrollMarginTop: 80,
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
