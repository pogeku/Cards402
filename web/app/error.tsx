'use client';

// Route-level error boundary. Fires when a server component throws at
// render time or a client component throws in an event handler after
// React has finished hydrating. The root layout keeps the marketing
// chrome around this element, so users still see the nav, footer, and
// brand — just with a contained error card in the main column.

import { useEffect } from 'react';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to the console for now. Wire up a real reporter (Sentry,
    // OpenTelemetry, self-hosted) when we stand one up — just swap
    // this implementation without touching every call site.
    // eslint-disable-next-line no-console
    console.error('[cards402] unhandled route error', error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 64px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4rem 1.35rem 6rem',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          maxWidth: 680,
          width: '100%',
          textAlign: 'center',
          position: 'relative',
        }}
      >
        <div className="type-eyebrow" style={{ color: 'var(--red)', marginBottom: '1.2rem' }}>
          HTTP 500 · Something broke
        </div>
        <h1
          className="type-display"
          style={{
            fontSize: 'clamp(2.6rem, 5vw + 0.5rem, 4.4rem)',
            color: 'var(--fg)',
            margin: '0 0 1.15rem',
            lineHeight: 0.96,
          }}
        >
          We hit an{' '}
          <span
            style={{
              fontStyle: 'italic',
              fontVariationSettings: '"opsz" 144, "SOFT" 80',
              color: 'var(--red)',
            }}
          >
            error
          </span>
          .
        </h1>
        <p
          className="type-body"
          style={{
            fontSize: '1rem',
            color: 'var(--fg-muted)',
            maxWidth: 540,
            margin: '0 auto 2rem',
          }}
        >
          This is our fault, not yours. The error has been logged and we&apos;ll look at it. In the
          meantime you can retry the page, head home, or email{' '}
          <a
            href="mailto:support@cards402.com"
            style={{
              color: 'var(--fg)',
              textDecoration: 'none',
              borderBottom: '1px solid var(--red-border)',
            }}
          >
            support@cards402.com
          </a>
          {error?.digest && (
            <>
              {' '}
              with this reference ID:{' '}
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78em',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '0.1em 0.4em',
                  color: 'var(--fg)',
                }}
              >
                {error.digest}
              </code>
            </>
          )}
          .
        </p>

        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => reset()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.55rem',
              padding: '0.85rem 1.35rem',
              borderRadius: 999,
              background: 'var(--fg)',
              color: 'var(--bg)',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.88rem',
              fontWeight: 600,
              fontFamily: 'var(--font-body)',
            }}
          >
            Try again
          </button>
          <Link
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.55rem',
              padding: '0.85rem 1.35rem',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--fg)',
              border: '1px solid var(--border-strong)',
              textDecoration: 'none',
              fontSize: '0.88rem',
              fontWeight: 500,
              fontFamily: 'var(--font-body)',
            }}
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
