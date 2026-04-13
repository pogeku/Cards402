import type { Metadata } from 'next';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Careers',
  description:
    'Join Cards402. Remote-first, flexible hours, published salaries. Building payment infrastructure for the autonomous agent economy.',
  alternates: { canonical: 'https://cards402.com/careers' },
  openGraph: ogForPage({
    title: 'Careers — Cards402',
    description: 'Remote-first. Published salaries. Building payment rails for AI agents.',
    path: '/careers',
  }),
  twitter: twitterForPage({
    title: 'Careers — Cards402',
    description: 'Remote-first. Published salaries. Building payment rails for AI agents.',
  }),
};

const BENEFITS = [
  {
    icon: '◉',
    title: 'Remote-first',
    body: 'Work 100% remotely from any country we can legally employ in. A quiet office in London is available if you want one.',
  },
  {
    icon: '◴',
    title: 'Flexible hours',
    body: "Night owl or early bird — we care about output. Four-hour overlap window in UTC for syncs, otherwise it's up to you.",
  },
  {
    icon: '◐',
    title: '28 days paid leave',
    body: 'Plus local public holidays. Plus a mandatory week off between Christmas and New Year. You will take the time.',
  },
  {
    icon: '⌘',
    title: 'Equipment allowance',
    body: '£3,000 to kit out your workstation on day one, refreshed every 3 years. Pick the keyboard.',
  },
  {
    icon: '☾',
    title: 'Learning budget',
    body: '£2,500/year for books, courses, conferences. Plus one paid week a year to go deep on something you chose.',
  },
  {
    icon: '✈',
    title: 'Team travel covered',
    body: 'Quarterly team offsites in good cities. Travel, hotel, meals covered. You get to pick a city.',
  },
  {
    icon: '♡',
    title: 'Health insurance',
    body: 'Private health + dental + mental health coverage in the US, UK, Canada, and the EU. Global coverage via a health spending account elsewhere.',
  },
  {
    icon: '⚕',
    title: 'Paid sick / family leave',
    body: '30 days fully-paid sick leave. 20 weeks fully-paid parental leave for every parent, regardless of role.',
  },
  {
    icon: '◎',
    title: 'Published salaries',
    body: 'Every job post lists the band up front. No negotiation theatre, no gender gap, no "we\'ll see where we land". The number on the ad is the number.',
  },
  {
    icon: '❖',
    title: 'Equity',
    body: 'Every full-time hire gets a meaningful slice. Vesting over four years with a one-year cliff. Standard ISO tax treatment where available.',
  },
  {
    icon: '✷',
    title: 'Performance bonuses',
    body: 'Annual company-wide bonus tied to revenue, plus discretionary shout-outs for exceptional work.',
  },
  {
    icon: '★',
    title: 'Relocation support',
    body: "If you want to move country for personal reasons, we'll help with visa sponsorship and up to £8,000 in relocation costs.",
  },
];

const JOBS = [
  {
    team: 'Engineering',
    title: 'Senior backend engineer',
    location: 'Remote · UTC ± 4',
    band: '£110,000 – £145,000 + equity',
    body: 'Own the fulfilment pipeline: Stellar watcher, order state machine, upstream card issuance, the SSE stream. Deep Node.js + SQLite experience, comfortable with payments correctness and long-lived async jobs.',
  },
  {
    team: 'Engineering',
    title: 'Frontend engineer · design-led',
    location: 'Remote · UTC ± 4',
    band: '£95,000 – £130,000 + equity',
    body: "Own the marketing site, the operator dashboard, and the design system behind both. Next.js 16, React 19, opinionated about type, comfortable writing motion and micro-interactions that aren't cheesy.",
  },
  {
    team: 'DevRel',
    title: 'Integration engineer · agents',
    location: 'Remote · Americas or Europe',
    band: '£90,000 – £115,000 + equity',
    body: "Build reference agents on top of Cards402. Ship example MCPs. Run office hours. Write the docs we haven't written yet. You are our feedback loop with the autonomous agent ecosystem.",
  },
  {
    team: 'Security',
    title: 'Platform security engineer',
    location: 'Remote · UTC ± 4',
    band: '£120,000 – £155,000 + equity',
    body: 'Own the security posture end-to-end. Key lifecycle, webhook signatures, secrets management, incident response. Comfortable with the Stellar smart contract layer and the Node.js runtime.',
  },
];

const REASONS = [
  {
    title: 'Get in at the ground level.',
    body: 'Cards402 is small, fast, and agile. You will directly impact the direction of the product and grow with the company from day one.',
  },
  {
    title: 'Make something real.',
    body: 'Not another analytics dashboard. A real payment rail that real autonomous agents use to buy real things on the real open internet. Measurable, on-chain impact.',
  },
  {
    title: 'Do your best work.',
    body: 'We staff for focus. Quiet mornings. Short meetings. Long uninterrupted stretches. We do not mistake activity for progress.',
  },
  {
    title: 'Opinions welcome.',
    body: "If you have a better way, we want to hear it. The loudest voice doesn't win — the best-argued one does. Entrepreneurs, rainmakers, and people who write design docs for fun all fit.",
  },
  {
    title: 'No theatre.',
    body: "No all-hands slideshows. No OKR ceremonies. No stand-up standups. We write things down and get out of each other's way.",
  },
  {
    title: 'We put you first.',
    body: "Our team is our lifeblood. The published salaries, the leave, the equity — none of that is marketing copy. It's how we protect the people we hire.",
  },
];

// JobPosting structured data — one entry per open role. Google uses
// this to index the listings into its Jobs surface. Dates default to
// "today" so the listings stay fresh as long as they remain on the
// page; we'll wire real datePosted fields when the roles become
// concrete.
function buildJobJsonLd(job: (typeof JOBS)[number]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.body,
    datePosted: new Date().toISOString().slice(0, 10),
    employmentType: 'FULL_TIME',
    hiringOrganization: {
      '@type': 'Organization',
      name: 'Cards402',
      sameAs: 'https://cards402.com',
      logo: 'https://cards402.com/icon.png',
    },
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: {
      '@type': 'Country',
      name: 'Worldwide',
    },
    directApply: false,
    applicationContact: {
      '@type': 'ContactPoint',
      email: 'careers@cards402.com',
    },
  };
}

export default function CareersPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(JOBS.map(buildJobJsonLd)),
        }}
      />
      <PageHero
        eyebrow="Careers"
        title="Come build payment rails for AI"
        accent="agents"
        intro="Cards402 is small, remote-first, and focused. We publish every salary, we hire from everywhere, and we don’t believe anyone should choose between doing great work and taking care of themselves. Below is what we offer and what we’re currently hiring for."
      />

      {/* Benefits grid */}
      <PageSection eyebrow="Benefits" title="What you get.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '0',
            borderTop: '1px solid var(--border)',
            borderLeft: '1px solid var(--border)',
          }}
        >
          {BENEFITS.map((b) => (
            <article
              key={b.title}
              style={{
                padding: '1.7rem 1.5rem 1.85rem',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg)',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '1rem',
                  color: 'var(--green)',
                  marginBottom: '0.9rem',
                  opacity: 0.85,
                }}
              >
                {b.icon}
              </div>
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.15rem',
                  fontWeight: 500,
                  letterSpacing: '-0.015em',
                  color: 'var(--fg)',
                  margin: '0 0 0.6rem',
                  lineHeight: 1.15,
                }}
              >
                {b.title}
              </h3>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.82rem',
                  color: 'var(--fg-muted)',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {b.body}
              </p>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Why */}
      <PageSection
        background="surface"
        eyebrow="Why Cards402"
        title="Six reasons to take the call."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.35rem',
          }}
        >
          {REASONS.map((r) => (
            <div
              key={r.title}
              style={{
                padding: '1.65rem 1.5rem 1.85rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 14,
              }}
            >
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.2rem',
                  fontWeight: 500,
                  color: 'var(--fg)',
                  margin: '0 0 0.7rem',
                  letterSpacing: '-0.015em',
                }}
              >
                {r.title}
              </h3>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.85rem',
                  color: 'var(--fg-muted)',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {r.body}
              </p>
            </div>
          ))}
        </div>
      </PageSection>

      {/* Open roles */}
      <PageSection eyebrow="Open roles" title="What we're hiring for.">
        <div
          style={{
            display: 'grid',
            gap: '0',
            borderTop: '1px solid var(--border)',
          }}
        >
          {JOBS.map((j) => (
            <article
              key={j.title}
              className="careers-job-row"
              style={{
                padding: '2rem 0',
                borderBottom: '1px solid var(--border)',
                display: 'grid',
                gridTemplateColumns: 'minmax(100px, 110px) minmax(0, 1fr) minmax(0, 0.9fr)',
                gap: '2rem',
                alignItems: 'start',
              }}
            >
              <div
                className="type-eyebrow"
                style={{
                  fontSize: '0.58rem',
                  color: 'var(--fg-dim)',
                  marginTop: '0.25rem',
                }}
              >
                {j.team}
              </div>
              <div>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.4rem',
                    fontWeight: 500,
                    color: 'var(--fg)',
                    margin: '0 0 0.5rem',
                    letterSpacing: '-0.02em',
                  }}
                >
                  {j.title}
                </h3>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.6rem 1rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.72rem',
                    color: 'var(--fg-dim)',
                    marginBottom: '0.85rem',
                  }}
                >
                  <span>{j.location}</span>
                  <span style={{ color: 'var(--green)' }}>{j.band}</span>
                </div>
                <p
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.88rem',
                    color: 'var(--fg-muted)',
                    lineHeight: 1.65,
                    margin: 0,
                    maxWidth: 560,
                  }}
                >
                  {j.body}
                </p>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                }}
              >
                <a
                  href={`mailto:careers@cards402.com?subject=Application: ${encodeURIComponent(j.title)}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.7rem 1.15rem',
                    borderRadius: 999,
                    background: 'transparent',
                    border: '1px solid var(--border-strong)',
                    color: 'var(--fg)',
                    textDecoration: 'none',
                    fontSize: '0.78rem',
                    fontFamily: 'var(--font-body)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  Apply →
                </a>
              </div>
            </article>
          ))}
        </div>
      </PageSection>

      {/* Don't see yourself */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 760,
            margin: '0 auto',
            padding: '3rem 2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            textAlign: 'center',
          }}
        >
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '0.9rem' }}>
            Don&apos;t see your role?
          </div>
          <h2
            className="type-display-tight"
            style={{
              fontSize: 'clamp(1.5rem, 2.8vw + 0.5rem, 2.1rem)',
              color: 'var(--fg)',
              margin: '0 auto 1.25rem',
              maxWidth: 560,
            }}
          >
            Tell us what you&apos;d build here anyway.
          </h2>
          <p
            className="type-body"
            style={{ fontSize: '0.92rem', maxWidth: 520, margin: '0 auto 1.85rem' }}
          >
            We read every email. If there&apos;s a role we should be hiring for and we&apos;re not,
            we want to know. Send your CV, a note on what you&apos;d own, and anything you&apos;ve
            built that we should see.
          </p>
          <a
            href="mailto:careers@cards402.com?subject=Speculative application"
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
            careers@cards402.com →
          </a>
        </div>
      </section>

      <style>{`
        @media (max-width: 820px) {
          .careers-job-row {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 0.75rem !important;
          }
        }
      `}</style>
    </>
  );
}
