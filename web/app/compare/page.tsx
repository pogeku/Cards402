import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Compare',
  description:
    'How Cards402 compares to traditional corporate cards, shared team cards, and other agent-payment rails. Honest trade-offs, not a sales table.',
  alternates: { canonical: 'https://cards402.com/compare' },
  openGraph: ogForPage({
    title: 'Compare — Cards402',
    description:
      'Cards402 versus corporate cards, shared team cards, and other agent-payment rails.',
    path: '/compare',
  }),
  twitter: twitterForPage({
    title: 'Compare — Cards402',
    description:
      'Cards402 versus corporate cards, shared team cards, and other agent-payment rails.',
  }),
};

// Feature rows for the head-to-head matrix. `cards402` is the canonical
// value we want to highlight; `corporate` and `shared` describe the two
// most common alternatives operators actually consider. Kept honest —
// every "worse" value for Cards402 is explicitly noted, not hidden.
type Cell = { value: string; note?: string; win?: boolean };
type Row = {
  label: string;
  cards402: Cell;
  corporate: Cell;
  shared: Cell;
};

const ROWS: Row[] = [
  {
    label: 'Onboarding',
    cards402: {
      value: 'Single command (claim code)',
      note: 'No forms, no approval wait',
      win: true,
    },
    corporate: {
      value: 'Days to weeks',
      note: 'Business verification, KYC, credit check',
    },
    shared: { value: 'Instant for the human', note: 'Hours for the agent to get access' },
  },
  {
    label: 'Card issuance',
    cards402: { value: 'Per purchase', note: '~60s on mainnet', win: true },
    corporate: { value: 'Per cardholder', note: 'Physical mail or virtual via admin' },
    shared: { value: 'One card, many users', note: 'Blast radius = shared' },
  },
  {
    label: 'Spend control',
    cards402: { value: 'Per-key spend cap', note: 'Policy-gated approvals optional' },
    corporate: { value: 'Per-cardholder limit', note: 'Re-approval for changes' },
    shared: { value: 'Trust-based', note: 'No technical enforcement' },
  },
  {
    label: 'Credentials in agent context',
    cards402: {
      value: 'Single-use claim code',
      note: 'Worthless after redemption',
      win: true,
    },
    corporate: { value: 'Card number pasted into prompt', note: 'Transcript exposure' },
    shared: { value: 'Card number pasted into prompt', note: 'Transcript exposure' },
  },
  {
    label: 'Custody',
    cards402: {
      value: 'Non-custodial',
      note: 'Agents pay the receiver contract directly',
      win: true,
    },
    corporate: { value: 'Issuer-custodial', note: 'Funds held by the bank' },
    shared: { value: 'Issuer-custodial', note: 'Funds held by the bank' },
  },
  {
    label: 'Funding source',
    cards402: {
      value: 'USDC or XLM on Stellar',
      note: 'Face value, no markup',
      win: true,
    },
    corporate: { value: 'Bank account / credit line', note: 'Fiat on/off ramp required' },
    shared: { value: 'Bank account / credit line', note: 'Same' },
  },
  {
    label: 'Per-order latency',
    cards402: { value: '~60s' },
    corporate: { value: 'Instant', note: 'Card already exists', win: true },
    shared: { value: 'Instant', note: 'Card already exists', win: true },
  },
  {
    label: 'Per-order cost',
    cards402: {
      value: '$0 markup',
      note: 'Only issuer fees ($2 + 2% FX)',
      win: true,
    },
    corporate: {
      value: 'Platform fees + interchange',
      note: 'Varies by provider',
    },
    shared: { value: '$0 extra', note: 'Already paid for the card' },
  },
  {
    label: 'Maximum per order',
    cards402: { value: '$1,000', note: 'Platform cap, raisable on request' },
    corporate: { value: 'Credit-line limit', note: 'Typically $10k+', win: true },
    shared: { value: 'Card balance', note: 'Whatever is loaded' },
  },
  {
    label: 'Works in the EU',
    cards402: { value: 'Yes', note: '$2 + 2% foreign txn fee' },
    corporate: { value: 'Yes', note: 'Native local rail' },
    shared: { value: 'Yes', note: 'Same terms as the shared card' },
  },
  {
    label: 'Agent-to-agent handoff',
    cards402: {
      value: 'Fresh card per agent',
      note: 'Bounded blast radius',
      win: true,
    },
    corporate: {
      value: 'Manual re-provisioning',
      note: 'Each new agent needs its own card',
    },
    shared: {
      value: 'Share the same card',
      note: 'One leak compromises everyone',
    },
  },
];

const SCENARIOS = [
  {
    title: 'You have one agent that makes occasional low-value purchases',
    verdict:
      'Either a shared team card or Cards402 works. Shared is faster to set up; Cards402 is safer if the agent is LLM-driven.',
  },
  {
    title: 'You have ten agents and want per-agent blast radius',
    verdict:
      'Cards402. Shared team cards collapse into one compromised credential; corporate-card provisioning takes days per agent.',
  },
  {
    title: 'You need a single recurring subscription paid from one card',
    verdict: 'Not Cards402 — Pathward reward cards block recurring charges. Use a corporate card.',
  },
  {
    title: 'You want predictable cost per transaction without platform markup',
    verdict: 'Cards402. Face value + issuer fees only, no per-order platform cut.',
  },
  {
    title: 'Your agents run on stablecoin-native infrastructure',
    verdict:
      'Cards402. Skip fiat on/off ramps entirely — pay the receiver contract directly in USDC or XLM.',
  },
  {
    title: 'You need a physical card or ATM access',
    verdict:
      'Not Cards402. Reward cards are virtual-only with no cash access. Use a corporate card.',
  },
];

// Renders one cell. Highlights the row's winning cell with a subtle
// border accent on the left side so the honest comparisons stay
// honest — we don't paint every Cards402 cell green.
function MatrixCell({ cell }: { cell: Cell }) {
  return (
    <td
      style={{
        padding: '1.15rem 1.2rem',
        verticalAlign: 'top',
        borderLeft: cell.win ? '2px solid var(--green)' : '2px solid transparent',
        background: cell.win ? 'var(--green-muted)' : 'transparent',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: '0.88rem',
          color: cell.win ? 'var(--fg)' : 'var(--fg)',
          fontWeight: cell.win ? 600 : 500,
          marginBottom: cell.note ? '0.35rem' : 0,
        }}
      >
        {cell.value}
      </div>
      {cell.note && (
        <div
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: '0.74rem',
            color: 'var(--fg-dim)',
            lineHeight: 1.5,
          }}
        >
          {cell.note}
        </div>
      )}
    </td>
  );
}

export default function ComparePage() {
  return (
    <>
      <PageHero
        eyebrow="Compare"
        title="Cards402 vs the"
        accent="alternatives"
        intro="Cards402 isn't the right answer for every agent-payment use case. This page is the honest matrix we'd show in a sales call — every row where a corporate card or a shared team card wins is explicitly marked. Use it to pick the right tool for the job you actually have."
      />

      {/* Head-to-head matrix */}
      <PageSection>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              minWidth: 720,
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '0.85rem 1.2rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.62rem',
                    fontWeight: 600,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--fg-dim)',
                    width: '22%',
                  }}
                >
                  Feature
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '0.85rem 1.2rem',
                    fontFamily: 'var(--font-display)',
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    color: 'var(--green)',
                    letterSpacing: '-0.015em',
                  }}
                >
                  Cards402
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '0.85rem 1.2rem',
                    fontFamily: 'var(--font-display)',
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    letterSpacing: '-0.015em',
                  }}
                >
                  Corporate card
                </th>
                <th
                  style={{
                    textAlign: 'left',
                    padding: '0.85rem 1.2rem',
                    fontFamily: 'var(--font-display)',
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    letterSpacing: '-0.015em',
                  }}
                >
                  Shared team card
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td
                    style={{
                      padding: '1.15rem 1.2rem',
                      verticalAlign: 'top',
                      fontFamily: 'var(--font-body)',
                      fontSize: '0.8rem',
                      color: 'var(--fg-muted)',
                      fontWeight: 500,
                      width: '22%',
                    }}
                  >
                    {row.label}
                  </td>
                  <MatrixCell cell={row.cards402} />
                  <MatrixCell cell={row.corporate} />
                  <MatrixCell cell={row.shared} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p
          style={{
            marginTop: '1.5rem',
            fontSize: '0.8rem',
            color: 'var(--fg-dim)',
            maxWidth: 720,
            fontFamily: 'var(--font-body)',
            lineHeight: 1.6,
          }}
        >
          Rows with the <span style={{ color: 'var(--green)' }}>green accent</span> are ones we
          think Cards402 genuinely wins. The others are either tied or lost — we&apos;re not
          painting the whole column green.
        </p>
      </PageSection>

      {/* Scenarios */}
      <PageSection
        background="surface"
        eyebrow="Picking the right tool"
        title="Six scenarios, plainly answered."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {SCENARIOS.map((s) => (
            <article
              key={s.title}
              style={{
                padding: '1.75rem 1.65rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 14,
              }}
            >
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.1rem',
                  fontWeight: 500,
                  letterSpacing: '-0.015em',
                  color: 'var(--fg)',
                  margin: '0 0 0.85rem',
                  lineHeight: 1.25,
                }}
              >
                {s.title}
              </h3>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                  color: 'var(--fg-muted)',
                  lineHeight: 1.65,
                  margin: 0,
                }}
              >
                {s.verdict}
              </p>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Closing / CTA */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 820,
            margin: '0 auto',
            padding: '2.75rem 2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div className="radial-green-glow" aria-hidden style={{ opacity: 0.15 }} />
          <div style={{ position: 'relative' }}>
            <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '0.9rem' }}>
              Not sure?
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.5rem, 2.8vw + 0.4rem, 2.1rem)',
                color: 'var(--fg)',
                margin: '0 0 1.25rem',
                maxWidth: 620,
              }}
            >
              Email us — we&apos;ll tell you if Cards402 is wrong for your use case.
            </h2>
            <p
              className="type-body"
              style={{ fontSize: '0.92rem', marginBottom: '1.85rem', maxWidth: 620 }}
            >
              A short email to{' '}
              <a
                href="mailto:hello@cards402.com"
                style={{
                  color: 'var(--fg)',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--green-border)',
                }}
              >
                hello@cards402.com
              </a>{' '}
              with what your agent is trying to do and how often. We&apos;ll come back with an
              honest answer in under a day. If the better tool for your use case is a corporate card
              or a shared team card, we&apos;ll tell you that.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <Link
                href="/docs/quickstart"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.55rem',
                  padding: '0.85rem 1.35rem',
                  borderRadius: 999,
                  background: 'var(--fg)',
                  color: 'var(--bg)',
                  textDecoration: 'none',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                }}
              >
                Quickstart →
              </Link>
              <Link
                href="/pricing"
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
                }}
              >
                Pricing
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
