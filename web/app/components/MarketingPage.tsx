// Shared scaffolding for flat marketing / legal pages. Everything
// production-critical (the landing page, HeroCard, docs page) owns its
// own layout. This is for the long tail: Pricing, Company, Careers,
// Security, Legal, Changelog, etc. One consistent hero header + a
// tokenised section wrapper so the tail doesn't drift visually over
// time.

import type { CSSProperties, ReactNode } from 'react';

export function PageHero({
  eyebrow,
  title,
  intro,
  accent,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  // Optional italic-serif accent word, rendered in green after the
  // title so every page keeps the same editorial feel as the landing
  // hero without needing bespoke markup.
  accent?: string;
  children?: ReactNode;
}) {
  return (
    <header
      style={{
        maxWidth: 1180,
        margin: '0 auto',
        padding: '5.5rem 1.35rem 3rem',
        position: 'relative',
      }}
    >
      <div
        className="type-eyebrow"
        style={{
          color: 'var(--green)',
          marginBottom: '1.15rem',
        }}
      >
        {eyebrow}
      </div>
      <h1
        className="type-display"
        style={{
          fontSize: 'clamp(2.4rem, 5vw + 0.5rem, 4.2rem)',
          color: 'var(--fg)',
          margin: '0 0 1.35rem',
          maxWidth: 860,
        }}
      >
        {title}
        {accent && (
          <>
            {' '}
            <span
              style={{
                fontStyle: 'italic',
                fontVariationSettings: '"opsz" 144, "SOFT" 80',
                color: 'var(--green)',
              }}
            >
              {accent}
            </span>
            .
          </>
        )}
      </h1>
      {intro && (
        <p
          className="type-body"
          style={{
            fontSize: '1.02rem',
            color: 'var(--fg-muted)',
            maxWidth: 640,
            margin: 0,
          }}
        >
          {intro}
        </p>
      )}
      {children}
    </header>
  );
}

export function PageSection({
  eyebrow,
  title,
  children,
  background,
  style,
}: {
  eyebrow?: string;
  title?: ReactNode;
  children: ReactNode;
  background?: 'plain' | 'surface' | 'bordered';
  style?: CSSProperties;
}) {
  const bgStyle: CSSProperties =
    background === 'surface'
      ? {
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
        }
      : background === 'bordered'
        ? { borderTop: '1px solid var(--border)' }
        : {};

  return (
    <section
      style={{
        padding: '4rem 1.35rem',
        ...bgStyle,
        ...style,
      }}
    >
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        {eyebrow && (
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1rem' }}>
            {eyebrow}
          </div>
        )}
        {title && (
          <h2
            className="type-display-tight"
            style={{
              fontSize: 'clamp(1.8rem, 3vw + 0.5rem, 2.6rem)',
              color: 'var(--fg)',
              margin: '0 0 2rem',
              maxWidth: 720,
            }}
          >
            {title}
          </h2>
        )}
        {children}
      </div>
    </section>
  );
}

// Stable slug from a heading. Used for anchor ids + TOC links so
// deep-linking into any legal section works from the sitemap, email,
// or Google SERP. Kept inline rather than extracted to a shared lib
// because every call site that needs it already lives in this file.
function legalSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/^[\d.]+\s*/, '') // drop leading "1.", "2." numbering
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Tight measure for legal / privacy / terms body copy. Renders a
// two-column layout on desktop: sticky section ToC on the left,
// content on the right. Collapses to a single column on < 900px
// with the ToC inlined above the body. The second arg is a list
// of `{heading, body}` so individual legal pages don't have to
// repeat the markup structure.
export function LegalBody({
  intro,
  sections,
}: {
  intro?: ReactNode;
  sections: Array<{ heading: string; body: ReactNode }>;
}) {
  return (
    <div
      className="legal-shell"
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: '2rem 1.35rem 6rem',
        display: 'grid',
        gridTemplateColumns: 'minmax(200px, 220px) minmax(0, 1fr)',
        gap: '3rem',
        alignItems: 'start',
      }}
    >
      {/* Sticky ToC */}
      <aside className="legal-toc">
        <div
          className="type-eyebrow"
          style={{
            color: 'var(--fg-dim)',
            marginBottom: '1rem',
            fontSize: '0.58rem',
          }}
        >
          On this page
        </div>
        <nav
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.15rem',
            borderLeft: '1px solid var(--border)',
            paddingLeft: '0.85rem',
          }}
        >
          {sections.map((s) => (
            <a
              key={s.heading}
              href={`#${legalSlug(s.heading)}`}
              className="legal-toc-link"
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: '0.8rem',
                color: 'var(--fg-muted)',
                textDecoration: 'none',
                padding: '0.35rem 0',
                lineHeight: 1.45,
                transition: 'color 0.3s var(--ease-out)',
                position: 'relative',
              }}
            >
              {s.heading}
            </a>
          ))}
        </nav>
      </aside>

      <div className="legal-body-column">
        {intro && (
          <p
            className="type-body"
            style={{
              fontSize: '0.98rem',
              color: 'var(--fg-muted)',
              marginBottom: '2.5rem',
              lineHeight: 1.72,
            }}
          >
            {intro}
          </p>
        )}
        {sections.map((s, i) => (
          <section
            key={s.heading}
            id={legalSlug(s.heading)}
            style={{
              marginTop: i === 0 ? 0 : '2.5rem',
              paddingTop: i === 0 ? 0 : '2.5rem',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              scrollMarginTop: 96,
            }}
          >
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '1.5rem',
                fontWeight: 500,
                letterSpacing: '-0.02em',
                color: 'var(--fg)',
                margin: '0 0 0.9rem',
              }}
            >
              {s.heading}
            </h2>
            <div
              className="legal-body-copy"
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: '0.95rem',
                lineHeight: 1.72,
                color: 'var(--fg-muted)',
              }}
            >
              {s.body}
            </div>
          </section>
        ))}
      </div>

      <style>{`
        .legal-toc {
          position: sticky;
          top: 96px;
          max-height: calc(100vh - 120px);
          overflow-y: auto;
        }
        .legal-toc-link:hover {
          color: var(--fg);
        }
        .legal-body-copy p { margin: 0 0 1rem; }
        .legal-body-copy p:last-child { margin-bottom: 0; }
        .legal-body-copy ul, .legal-body-copy ol {
          margin: 0 0 1rem; padding-left: 1.25rem;
        }
        .legal-body-copy li { margin-bottom: 0.35rem; }
        .legal-body-copy strong { color: var(--fg); font-weight: 600; }
        .legal-body-copy a {
          color: var(--fg);
          text-decoration: none;
          border-bottom: 1px solid var(--green-border);
        }

        @media (max-width: 900px) {
          .legal-shell {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 2rem !important;
          }
          .legal-toc {
            position: static;
            max-height: none;
            order: -1;
            padding: 1rem 1.15rem;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 10px;
          }
          .legal-toc nav {
            flex-direction: column !important;
          }
        }
      `}</style>
    </div>
  );
}
