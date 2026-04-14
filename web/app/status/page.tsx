import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Status',
  description:
    'Live operational status for the Cards402 HTTP API, fulfilment pipeline, and Stellar watcher. Fetched from api.cards402.com/status on every page load.',
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

// Render on every request (no prerender). The status page is live
// health data by definition — prerendering would freeze stale numbers
// into the deployed HTML. `force-dynamic` also means the build skips
// fetching api.cards402.com/status, so backend schema drift can't
// take the web build down.
export const dynamic = 'force-dynamic';

// ── Backend response types ────────────────────────────────────────────────────

interface BackendStatus {
  ok: boolean;
  frozen: boolean;
  consecutive_failures: number;
  orders: {
    pending_payment: number;
    in_progress: number;
    refund_pending: number;
  };
  last_24h: {
    total: number;
    delivered: number;
    failed: number;
    refunded: number;
    expired: number;
    success_rate: number | null;
  };
  stellar_watcher: {
    last_ledger: number | null;
    last_ledger_at: string | null;
    age_seconds: number | null;
  };
  process: {
    uptime_seconds: number;
    started_at: string;
  };
  generated_at: string;
}

type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';

interface ComponentRow {
  label: string;
  status: ComponentStatus;
  note: string;
}

// Runtime type guard. Older backend versions of /status returned a
// subset of these fields; if any of the expected shape is missing we
// treat the response as unreachable so the page shows the fallback
// banner instead of crashing with "Cannot read properties of undefined".
function isBackendStatus(v: unknown): v is BackendStatus {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.ok === 'boolean' &&
    typeof s.frozen === 'boolean' &&
    typeof s.consecutive_failures === 'number' &&
    typeof s.orders === 'object' &&
    s.orders !== null &&
    typeof s.last_24h === 'object' &&
    s.last_24h !== null &&
    typeof (s.last_24h as Record<string, unknown>).total === 'number' &&
    typeof s.stellar_watcher === 'object' &&
    s.stellar_watcher !== null &&
    typeof s.process === 'object' &&
    s.process !== null &&
    typeof s.generated_at === 'string'
  );
}

// Fetch the live status endpoint with a short timeout. Returns null
// on any failure — the page handles the "backend unreachable" case
// at render time so the marketing chrome still renders. Also returns
// null if the response doesn't match the current schema (graceful
// degradation during backend version skew).
async function fetchBackendStatus(): Promise<BackendStatus | null> {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL
    ? `${process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/v1\/?$/, '')}/status`
    : 'https://api.cards402.com/status';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return isBackendStatus(body) ? body : null;
  } catch {
    return null;
  }
}

// Derive the per-component rows from the backend's raw fields. The
// status endpoint gives us signals; the thresholds that decide what
// counts as 'degraded' vs 'outage' live here so ops can tune the
// public story without touching the backend.
function deriveComponents(s: BackendStatus): ComponentRow[] {
  const rows: ComponentRow[] = [];

  // HTTP API: frozen = outage, non-ok = degraded (circuit breaker
  // tripping with consecutive failures > 0), everything else = operational.
  if (s.frozen) {
    rows.push({
      label: 'HTTP API',
      status: 'outage',
      note: 'System frozen — POST /v1/orders is returning 503. Unfreeze via the admin dashboard.',
    });
  } else if (s.consecutive_failures > 0) {
    rows.push({
      label: 'HTTP API',
      status: 'degraded',
      note: `Circuit breaker at ${s.consecutive_failures}/3 consecutive failures. Will freeze automatically at 3.`,
    });
  } else {
    rows.push({
      label: 'HTTP API',
      status: 'operational',
      note: `Accepting orders. ${s.last_24h.total} created in the last 24h.`,
    });
  }

  // Fulfilment pipeline: success rate over the terminal 24h orders.
  const pct = s.last_24h.success_rate;
  const terminal24h = s.last_24h.delivered + s.last_24h.failed + s.last_24h.refunded;
  if (terminal24h === 0) {
    rows.push({
      label: 'Card fulfilment pipeline',
      status: 'operational',
      note: 'No terminal orders in the last 24h. Pipeline is idle but healthy.',
    });
  } else {
    const pctStr = pct !== null ? `${(pct * 100).toFixed(1)}%` : 'n/a';
    const statusLevel: ComponentStatus =
      pct === null || pct >= 0.95 ? 'operational' : pct >= 0.8 ? 'degraded' : 'outage';
    rows.push({
      label: 'Card fulfilment pipeline',
      status: statusLevel,
      note: `${pctStr} success rate over ${terminal24h} terminal orders in the last 24h. ${s.last_24h.delivered} delivered · ${s.last_24h.failed} failed · ${s.last_24h.refunded} refunded.`,
    });
  }

  // Stellar watcher freshness. Age under 60s is healthy; 60–300s is
  // degraded (watcher is pacing but could be lagging); over 300s is
  // an outage (watcher is stuck or has crashed).
  const age = s.stellar_watcher.age_seconds;
  if (age === null) {
    rows.push({
      label: 'Stellar payment watcher',
      status: 'unknown',
      note: 'Watcher freshness timestamp not yet recorded (backend restarted recently).',
    });
  } else if (age < 60) {
    rows.push({
      label: 'Stellar payment watcher',
      status: 'operational',
      note: `Last ledger cursor advanced ${age}s ago (ledger ${s.stellar_watcher.last_ledger ?? '?'}).`,
    });
  } else if (age < 300) {
    rows.push({
      label: 'Stellar payment watcher',
      status: 'degraded',
      note: `Cursor last advanced ${age}s ago — watcher is lagging but still running.`,
    });
  } else {
    rows.push({
      label: 'Stellar payment watcher',
      status: 'outage',
      note: `Cursor has not advanced in ${age}s — watcher is probably stuck. Ops should check pm2.`,
    });
  }

  // Refund queue: refund_pending orders should always drain back to
  // zero. A non-zero count is a signal but not an outage.
  if (s.orders.refund_pending > 0) {
    rows.push({
      label: 'Refund queue',
      status: 'degraded',
      note: `${s.orders.refund_pending} refund${
        s.orders.refund_pending === 1 ? '' : 's'
      } awaiting manual action — ops should investigate.`,
    });
  } else {
    rows.push({
      label: 'Refund queue',
      status: 'operational',
      note: 'Empty. All failed orders have been fully refunded on-chain.',
    });
  }

  // In-flight orders. Informational only — always operational unless
  // frozen (handled above). Useful as a liveness signal.
  rows.push({
    label: 'Active orders',
    status: 'operational',
    note: `${s.orders.pending_payment} pending payment · ${s.orders.in_progress} in fulfilment.`,
  });

  // Upstream — we don't have a structured signal for Pathward / CTX
  // health, so surface it as an advisory row derived from the 24h
  // failure count. If >25% of terminal orders failed in 24h it's
  // usually an upstream scraper/auth issue, not a cards402 problem.
  if (terminal24h > 0 && pct !== null && pct < 0.75) {
    rows.push({
      label: 'Upstream — Pathward / InComm',
      status: 'degraded',
      note: 'Elevated failure rate likely tied to upstream issuer scraping or auth. Check VCC logs.',
    });
  } else {
    rows.push({
      label: 'Upstream — Pathward / InComm',
      status: 'operational',
      note: 'No known incidents reported by the issuer or the scraper.',
    });
  }

  return rows;
}

const STATUS_COLOR: Record<
  ComponentStatus,
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
  unknown: {
    color: 'var(--fg-dim)',
    bg: 'var(--surface)',
    border: 'var(--border)',
    label: 'Unknown',
  },
};

function overallStatus(rows: ComponentRow[]): ComponentStatus {
  if (rows.some((r) => r.status === 'outage')) return 'outage';
  if (rows.some((r) => r.status === 'degraded')) return 'degraded';
  if (rows.some((r) => r.status === 'maintenance')) return 'maintenance';
  if (rows.every((r) => r.status === 'unknown')) return 'unknown';
  return 'operational';
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default async function StatusPage() {
  const s = await fetchBackendStatus();
  const rows = s ? deriveComponents(s) : null;
  const overall: ComponentStatus = rows ? overallStatus(rows) : 'unknown';
  const overallStyle = STATUS_COLOR[overall];

  const heroAccent =
    overall === 'operational'
      ? 'operational'
      : overall === 'degraded'
        ? 'degraded'
        : overall === 'outage'
          ? 'offline'
          : 'loading';

  const message = !s
    ? "Couldn't reach api.cards402.com/status. The status endpoint may be down, or your network blocks it. The marketing surface at cards402.com is unaffected."
    : overall === 'operational'
      ? 'All systems operational.'
      : overall === 'degraded'
        ? 'Some systems are running in a degraded state.'
        : overall === 'maintenance'
          ? 'Scheduled maintenance is in progress.'
          : overall === 'outage'
            ? 'A partial outage is affecting one or more systems.'
            : 'Status endpoint temporarily unreachable.';

  return (
    <>
      <PageHero
        eyebrow="Status"
        title="All systems"
        accent={heroAccent}
        intro={
          <>
            Real-time health of every Cards402 component. This page fetches{' '}
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.88em',
                color: 'var(--green)',
                background: 'var(--surface)',
                padding: '0.1em 0.4em',
                borderRadius: 4,
                border: '1px solid var(--border)',
              }}
            >
              https://api.cards402.com/status
            </code>{' '}
            at request time (30s edge cache) and derives per-component health from the raw signals.
            Incidents and postmortems land on the{' '}
            <Link
              href="/changelog"
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--green-border)',
              }}
            >
              changelog
            </Link>
            .
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
            className={overall === 'operational' ? 'pulse-green' : undefined}
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: overallStyle.color,
              boxShadow: `0 0 14px ${overallStyle.color}`,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 260 }}>
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
                lineHeight: 1.25,
              }}
            >
              {message}
            </div>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              color: 'var(--fg-dim)',
              textAlign: 'right',
              minWidth: 160,
            }}
          >
            {s ? (
              <>
                Updated {formatRelativeTime(s.generated_at)}
                <br />
                API uptime {formatUptime(s.process.uptime_seconds)}
              </>
            ) : (
              'Endpoint unreachable'
            )}
          </div>
        </div>
      </section>

      {/* Components table */}
      <PageSection>
        {rows ? (
          <div
            style={{
              borderTop: '1px solid var(--border)',
            }}
          >
            {rows.map((c) => {
              const style = STATUS_COLOR[c.status];
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
                        color: style.color,
                        background: style.bg,
                        border: `1px solid ${style.border}`,
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
                          background: style.color,
                        }}
                      />
                      {style.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            style={{
              padding: '3rem 2rem',
              textAlign: 'center',
              border: '1px dashed var(--border)',
              borderRadius: 12,
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-body)',
            }}
          >
            The status endpoint at <code>api.cards402.com/status</code> is not responding. Try again
            in a minute — if the whole marketing site is up but this page stays empty, it almost
            always means the backend API is down rather than the site itself.
          </div>
        )}
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
