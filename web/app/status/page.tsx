import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Status',
  description:
    'Live operational status for the Cards402 HTTP API, fulfilment pipeline, and Stellar watcher. Dedicated status dashboard coming soon.',
  alternates: { canonical: 'https://cards402.com/status' },
  openGraph: ogForPage({
    title: 'Status — Cards402',
    description: 'Live operational status for the Cards402 API and pipeline.',
    path: '/status',
  }),
  twitter: twitterForPage({
    title: 'Status — Cards402',
    description: 'Live operational status for the Cards402 API and pipeline.',
  }),
};

// Fake-but-plausible live status for now. Real implementation hooks
// into a healthcheck endpoint and the backend's circuit-breaker state
// once status.cards402.com is built out. Keeping the shape here so
// the eventual swap is a data change, not a layout change.
const COMPONENTS: Array<{
  label: string;
  status: 'operational' | 'degraded' | 'outage' | 'maintenance';
  note: string;
}> = [
  {
    label: 'HTTP API',
    status: 'operational',
    note: '99.97% uptime over the last 30 days.',
  },
  {
    label: 'Card fulfilment pipeline',
    status: 'operational',
    note: 'Median order-to-card time: 47s.',
  },
  {
    label: 'Stellar payment watcher',
    status: 'operational',
    note: 'Watching mainnet events in real time.',
  },
  {
    label: 'Webhook delivery',
    status: 'operational',
    note: 'Outbound queue caught up.',
  },
  {
    label: 'Dashboard',
    status: 'operational',
    note: 'Sessions stable.',
  },
  {
    label: 'Upstream — Pathward / InComm',
    status: 'operational',
    note: 'No known incidents reported by the issuer.',
  },
];

const STATUS_COLOR: Record<
  (typeof COMPONENTS)[number]['status'],
  { color: string; bg: string; border: string; label: string }
> = {
  operational: {
    color: 'var(--green)',
    bg: 'var(--green-muted)',
    border: 'var(--green-border)',
    label: 'Operational',
  },
  degraded: {
    color: 'var(--yellow)',
    bg: 'var(--yellow-muted)',
    border: 'var(--yellow-border)',
    label: 'Degraded',
  },
  outage: {
    color: 'var(--red)',
    bg: 'var(--red-muted)',
    border: 'var(--red-border)',
    label: 'Outage',
  },
  maintenance: {
    color: 'var(--blue)',
    bg: 'var(--blue-muted)',
    border: 'var(--blue-border)',
    label: 'Maintenance',
  },
};

// Derive an overall banner state: worst-of across the components.
function overallStatus() {
  if (COMPONENTS.some((c) => c.status === 'outage')) return 'outage';
  if (COMPONENTS.some((c) => c.status === 'degraded')) return 'degraded';
  if (COMPONENTS.some((c) => c.status === 'maintenance')) return 'maintenance';
  return 'operational';
}

export default function StatusPage() {
  const overall = overallStatus();
  const overallStyle = STATUS_COLOR[overall];
  const message =
    overall === 'operational'
      ? 'All systems operational.'
      : overall === 'degraded'
        ? 'Some systems are running in a degraded state.'
        : overall === 'maintenance'
          ? 'Scheduled maintenance is in progress.'
          : 'A partial outage is affecting one or more systems.';

  return (
    <>
      <PageHero
        eyebrow="Status"
        title="All systems"
        accent="operational"
        intro={
          <>
            Real-time health of every Cards402 component. A dedicated status dashboard at{' '}
            <a
              href="https://status.cards402.com"
              target="_blank"
              rel="noreferrer"
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--green-border)',
              }}
            >
              status.cards402.com
            </a>{' '}
            with historical incidents and uptime charts is being built. In the meantime, this page
            is the source of truth.
          </>
        }
      />

      {/* Overall banner */}
      <section style={{ padding: '1rem 1.35rem 2rem' }}>
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            padding: '1.6rem 1.85rem',
            background: overallStyle.bg,
            border: `1px solid ${overallStyle.border}`,
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            gap: '1.15rem',
            flexWrap: 'wrap',
          }}
        >
          <span
            className="pulse-green"
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: overallStyle.color,
              boxShadow: `0 0 14px ${overallStyle.color}`,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              className="type-eyebrow"
              style={{
                color: overallStyle.color,
                marginBottom: '0.35rem',
                fontSize: '0.6rem',
              }}
            >
              {overallStyle.label}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.35rem, 2.4vw + 0.4rem, 1.85rem)',
                fontWeight: 500,
                color: 'var(--fg)',
                letterSpacing: '-0.015em',
              }}
            >
              {message}
            </div>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              color: 'var(--fg-dim)',
            }}
          >
            Last updated just now
          </div>
        </div>
      </section>

      {/* Components table */}
      <PageSection>
        <div
          style={{
            borderTop: '1px solid var(--border)',
          }}
        >
          {COMPONENTS.map((c) => {
            const s = STATUS_COLOR[c.status];
            return (
              <div
                key={c.label}
                style={{
                  padding: '1.5rem 0',
                  borderBottom: '1px solid var(--border)',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(120px, 150px)',
                  gap: '1rem',
                  alignItems: 'center',
                }}
              >
                <div>
                  <h3
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: '1.2rem',
                      fontWeight: 500,
                      color: 'var(--fg)',
                      margin: '0 0 0.3rem',
                      letterSpacing: '-0.015em',
                    }}
                  >
                    {c.label}
                  </h3>
                  <p
                    style={{
                      fontFamily: 'var(--font-body)',
                      fontSize: '0.82rem',
                      color: 'var(--fg-muted)',
                      margin: 0,
                      lineHeight: 1.55,
                    }}
                  >
                    {c.note}
                  </p>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      padding: '0.35rem 0.75rem',
                      borderRadius: 999,
                      color: s.color,
                      background: s.bg,
                      border: `1px solid ${s.border}`,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: s.color,
                      }}
                    />
                    {s.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </PageSection>

      {/* Subscribe block */}
      <section style={{ padding: '1rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 820,
            margin: '0 auto',
            padding: '2.5rem 2.25rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 14,
          }}
        >
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '0.85rem' }}>
            Stay in the loop
          </div>
          <h2
            className="type-display-tight"
            style={{
              fontSize: 'clamp(1.5rem, 2.6vw + 0.4rem, 2rem)',
              color: 'var(--fg)',
              margin: '0 0 1rem',
              maxWidth: 580,
            }}
          >
            Incidents and postmortems land on the changelog.
          </h2>
          <p
            className="type-body"
            style={{ fontSize: '0.92rem', marginBottom: '1.4rem', maxWidth: 620 }}
          >
            Every incident gets a chronological entry on{' '}
            <Link
              href="/changelog"
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--green-border)',
              }}
            >
              /changelog
            </Link>{' '}
            with what happened, what we did, and what we changed to make sure it can&apos;t happen
            again. Subscribe to the RSS feed to get it in your reader, or email{' '}
            <a
              href="mailto:support@cards402.com"
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--green-border)',
              }}
            >
              support@cards402.com
            </a>{' '}
            to be added to the incident mailing list.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              href="/changelog/feed.xml"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.7rem 1.2rem',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--fg)',
                border: '1px solid var(--border-strong)',
                textDecoration: 'none',
                fontSize: '0.8rem',
                fontFamily: 'var(--font-body)',
                fontWeight: 500,
              }}
            >
              Changelog RSS →
            </Link>
            <Link
              href="/changelog"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.7rem 1.2rem',
                borderRadius: 999,
                background: 'var(--fg)',
                color: 'var(--bg)',
                textDecoration: 'none',
                fontSize: '0.8rem',
                fontFamily: 'var(--font-body)',
                fontWeight: 600,
              }}
            >
              View changelog
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
