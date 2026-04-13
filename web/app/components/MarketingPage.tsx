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

// Tight measure for legal / privacy / terms body copy. Renders a
// single column with the serif h2s and proportional body. The second
// arg is a list of `{heading, body}` so individual legal pages don't
// have to repeat the markup structure.
export function LegalBody({
  intro,
  sections,
}: {
  intro?: ReactNode;
  sections: Array<{ heading: string; body: ReactNode }>;
}) {
  return (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '2rem 1.35rem 6rem',
      }}
    >
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
          style={{
            marginTop: i === 0 ? 0 : '2.5rem',
            paddingTop: i === 0 ? 0 : '2.5rem',
            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
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

      <style>{`
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
      `}</style>
    </div>
  );
}
