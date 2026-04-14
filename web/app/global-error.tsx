'use client';

// Fallback for errors that happen inside the root layout itself.
// When the regular app/error.tsx boundary can't render — typically
// because RootLayout threw or a provider at the top failed — Next.js
// mounts this component instead. It is NOT wrapped in the root
// layout, so it has to ship its own <html> and <body> tags and
// whatever bare-minimum styling we need to stay on-brand.
//
// Rules for this file:
// - Client Component (error boundaries cannot be server components)
// - No metadata/generateMetadata exports (Next.js ignores them here)
// - No imports that could themselves throw during layout failure —
//   stay off the design system, off next/font, off anything that
//   touches context providers. Inline styles only.
// - Inline fonts: system stack so we never depend on next/font
//   succeeding. The page still renders if every font in the list
//   404s.

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#050505',
          color: '#f4f4f4',
          fontFamily: 'Georgia, "Times New Roman", serif, -apple-system, BlinkMacSystemFont',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          textAlign: 'center',
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        }}
      >
        <div style={{ maxWidth: 560 }}>
          <div
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#ff7a7a',
              marginBottom: 20,
            }}
          >
            Cards402 · HTTP 500 · Fatal
          </div>
          <h1
            style={{
              fontSize: 56,
              letterSpacing: '-0.03em',
              fontWeight: 500,
              lineHeight: 0.96,
              margin: '0 0 18px',
              color: '#f4f4f4',
            }}
          >
            Something&nbsp;
            <span style={{ fontStyle: 'italic', color: '#ff7a7a' }}>really</span>
            &nbsp;broke.
          </h1>
          <p
            style={{
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
              fontSize: 16,
              lineHeight: 1.7,
              color: 'rgba(255,255,255,0.66)',
              margin: '0 0 28px',
            }}
          >
            The page failed before our regular error handler could recover. This is our fault;
            we&apos;ve logged it. Email{' '}
            <a
              href="mailto:support@cards402.com"
              style={{
                color: '#f4f4f4',
                textDecoration: 'none',
                borderBottom: '1px solid rgba(255, 122, 122, 0.4)',
              }}
            >
              support@cards402.com
            </a>{' '}
            if it keeps happening
            {error?.digest ? (
              <>
                {' '}
                and include this reference ID:{' '}
                <code
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: '0.86em',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 4,
                    padding: '0.1em 0.4em',
                    color: '#f4f4f4',
                  }}
                >
                  {error.digest}
                </code>
              </>
            ) : null}
            .
          </p>
          <a
            href="/"
            style={{
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 20px',
              borderRadius: 999,
              background: '#f4f4f4',
              color: '#050505',
              textDecoration: 'none',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Back to cards402.com
          </a>
        </div>
      </body>
    </html>
  );
}
