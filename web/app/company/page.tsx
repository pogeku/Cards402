import type { Metadata } from 'next';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Company',
  description:
    "Cards402 is a small team building payment infrastructure for AI agents. Here's who we are and where we're going.",
  alternates: { canonical: 'https://cards402.com/company' },
  openGraph: ogForPage({
    title: 'Company — Cards402',
    description: 'Payment infrastructure for AI agents. Built by a small, focused team.',
    path: '/company',
  }),
  twitter: twitterForPage({
    title: 'Company — Cards402',
    description: 'Payment infrastructure for AI agents.',
  }),
};

const PRINCIPLES = [
  {
    title: 'Agents are the customer.',
    body: 'Not the humans who build them. Every design decision — from claim codes to the SSE stream to non-custodial payments — starts by asking "what does a program need that a dashboard user doesn\'t?".',
  },
  {
    title: 'Ship one good thing.',
    body: 'Cards402 does one job: turn a Stellar payment into a Visa card. We will not bolt on a rewards programme, a fiat on-ramp, or a chat widget. Depth over breadth, forever.',
  },
  {
    title: 'Write it down.',
    body: 'Every non-obvious decision ends up in a design doc, and every design doc eventually shows up on the docs site. If the only person who understands a subsystem is the person who wrote it, we failed.',
  },
  {
    title: 'Honest by default.',
    body: 'Cards at face value. No dark patterns. No free-trial auto-renewal traps. No "we\'ll get back to you in 5–7 business days" when the real answer is next quarter. We tell you what happened and when.',
  },
];

const MILESTONES = [
  {
    date: 'Q1 2026',
    title: 'Private beta — Stellar Mainnet launch',
    body: 'First live orders fulfilled end-to-end. ~33s from payment confirmation to PAN delivery.',
    status: 'Shipped',
  },
  {
    date: 'Q2 2026',
    title: 'Non-custodial v2 + MCP server',
    body: 'Agents now pay the receiver contract directly. Claude Desktop integration via the Cards402 MCP server.',
    status: 'Shipped',
  },
  {
    date: 'Q3 2026',
    title: 'Multi-merchant routing',
    body: 'Expand beyond the initial reward-card supplier so agents can pick the best card for each use case.',
    status: 'In progress',
  },
  {
    date: 'Q4 2026',
    title: 'EU IBAN + on-chain reporting',
    body: 'European IBAN accounts for agents that need a non-card rail. Transparent on-chain reporting of Cards402 treasury flow.',
    status: 'Planned',
  },
];

export default function CompanyPage() {
  return (
    <>
      <PageHero
        eyebrow="Company"
        title="Payment infrastructure for autonomous"
        accent="agents"
        intro="Cards402 was started because there was no way for an LLM agent to buy something on the open internet without a human holding its hand. Not without pasting a card number into a chat. Not without a human approving every transaction. Not without giving up custody. We're fixing that — carefully, one primitive at a time."
      />

      {/* Mission */}
      <PageSection>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1.2fr)',
            gap: '3rem',
            alignItems: 'start',
          }}
          className="company-mission-grid"
        >
          <div>
            <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1rem' }}>
              Mission
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.8rem, 3vw + 0.4rem, 2.5rem)',
                color: 'var(--fg)',
                margin: 0,
                lineHeight: 1.05,
              }}
            >
              Make the open internet payable, without the human loop.
            </h2>
          </div>
          <div>
            <p className="type-body" style={{ fontSize: '1rem', marginBottom: '1.2rem' }}>
              The web assumed a human was always there, at the other end of a checkout form, tapping
              a 3-D Secure OTP out of an iPhone. AI agents broke that assumption a year ago. The
              industry responded with either &ldquo;wrap it in a shared corporate card&rdquo; or
              &ldquo;let the agent ask the human&rdquo;. Neither scales.
            </p>
            <p className="type-body" style={{ fontSize: '1rem', marginBottom: '1.2rem' }}>
              Cards402 is the middle answer. A stablecoin payment in, a real card out, and a
              non-custodial architecture so no single party — not us, not a custodian, not a
              compromised operator — can divert agent funds in flight. Boring, correct, and mostly
              invisible. That&apos;s the job.
            </p>
          </div>
        </div>
      </PageSection>

      {/* Principles */}
      <PageSection
        background="surface"
        eyebrow="Principles"
        title="Four things we refuse to compromise on."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '0',
            borderTop: '1px solid var(--border)',
            borderLeft: '1px solid var(--border)',
          }}
        >
          {PRINCIPLES.map((p) => (
            <article
              key={p.title}
              style={{
                padding: '1.85rem 1.65rem 2.15rem',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg)',
              }}
            >
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.3rem',
                  fontWeight: 500,
                  letterSpacing: '-0.02em',
                  color: 'var(--fg)',
                  margin: '0 0 0.85rem',
                  lineHeight: 1.12,
                }}
              >
                {p.title}
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
                {p.body}
              </p>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Milestones */}
      <PageSection eyebrow="Timeline" title="Where we are and where we're going.">
        <div
          style={{
            display: 'grid',
            gap: '0',
            borderTop: '1px solid var(--border)',
          }}
        >
          {MILESTONES.map((m) => (
            <div
              key={m.title}
              style={{
                padding: '2rem 0',
                borderBottom: '1px solid var(--border)',
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 140px) minmax(0, 1fr) minmax(120px, 140px)',
                gap: '2rem',
                alignItems: 'baseline',
              }}
              className="company-milestone-row"
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.72rem',
                  color: 'var(--fg-dim)',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                {m.date}
              </div>
              <div>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.3rem',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    margin: '0 0 0.5rem',
                    letterSpacing: '-0.02em',
                  }}
                >
                  {m.title}
                </h3>
                <p
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.88rem',
                    color: 'var(--fg-muted)',
                    lineHeight: 1.6,
                    margin: 0,
                    maxWidth: 580,
                  }}
                >
                  {m.body}
                </p>
              </div>
              <div>
                <span
                  className={m.status === 'Shipped' ? 'status-delivered' : ''}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.68rem',
                    padding: '0.28rem 0.6rem',
                    borderRadius: 999,
                    border: '1px solid',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    color:
                      m.status === 'Shipped'
                        ? 'var(--green)'
                        : m.status === 'In progress'
                          ? 'var(--yellow)'
                          : 'var(--fg-dim)',
                    borderColor:
                      m.status === 'Shipped'
                        ? 'var(--green-border)'
                        : m.status === 'In progress'
                          ? 'var(--yellow-border)'
                          : 'var(--border-strong)',
                    background:
                      m.status === 'Shipped'
                        ? 'var(--green-muted)'
                        : m.status === 'In progress'
                          ? 'var(--yellow-muted)'
                          : 'transparent',
                  }}
                >
                  {m.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </PageSection>

      {/* Closing contact */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 920,
            margin: '0 auto',
            padding: '3rem 2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 16,
          }}
        >
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '0.9rem' }}>
            Contact
          </div>
          <h2
            className="type-display-tight"
            style={{
              fontSize: 'clamp(1.5rem, 2.8vw + 0.5rem, 2.1rem)',
              color: 'var(--fg)',
              margin: '0 0 1.35rem',
              maxWidth: 620,
            }}
          >
            Want to work with us, invest, or just say hi?
          </h2>
          <div
            style={{
              display: 'flex',
              gap: '1.5rem',
              flexWrap: 'wrap',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
            }}
          >
            {[
              ['General', 'hello@cards402.com'],
              ['Careers', 'careers@cards402.com'],
              ['Press', 'press@cards402.com'],
              ['Partnerships', 'partners@cards402.com'],
            ].map(([label, email]) => (
              <div key={label}>
                <div
                  className="type-eyebrow"
                  style={{ fontSize: '0.58rem', marginBottom: '0.35rem' }}
                >
                  {label}
                </div>
                <a
                  href={`mailto:${email}`}
                  style={{
                    color: 'var(--fg)',
                    textDecoration: 'none',
                    borderBottom: '1px solid var(--green-border)',
                  }}
                >
                  {email}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <style>{`
        @media (max-width: 820px) {
          .company-mission-grid { grid-template-columns: minmax(0, 1fr) !important; gap: 1.5rem !important; }
          .company-milestone-row { grid-template-columns: minmax(0, 1fr) !important; gap: 0.75rem !important; }
        }
      `}</style>
    </>
  );
}
