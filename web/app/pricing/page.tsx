import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

const DESCRIPTION =
  'Cards402 sells Visa reward cards at face value. No signup fee, no markup. Issuer-imposed fees are $2.00 + 2% on foreign transactions, $5.95 for replacement, and $2.50/month after six months.';

export const metadata: Metadata = {
  title: 'Pricing',
  description: DESCRIPTION,
  alternates: { canonical: 'https://cards402.com/pricing' },
  openGraph: ogForPage({
    title: 'Pricing — Cards402',
    description: 'Cards at face value. Honest fees. Pay in USDC or XLM on Stellar.',
    path: '/pricing',
  }),
  twitter: twitterForPage({
    title: 'Pricing — Cards402',
    description: 'Cards at face value. Honest fees.',
  }),
};

const FEE_ROWS = [
  {
    label: 'Cards402 service fee',
    value: '$0.00',
    note: 'We take zero markup on the card face value. You pay exactly what the card loads with.',
    highlight: true,
  },
  {
    label: 'Signup / account fee',
    value: '$0.00',
    note: 'No subscription, no seat licensing, no minimum volume commitment.',
    highlight: true,
  },
  {
    label: 'Order cancellation',
    value: '$0.00',
    note: 'Unpaid orders expire after 2 hours. No funds taken, no fee.',
    highlight: true,
  },
  {
    label: 'Foreign transaction fee',
    value: '$2.00 + 2%',
    note: 'Charged by the issuer (Pathward) on transactions in any currency or country other than the card currency.',
  },
  {
    label: 'Card replacement',
    value: '$5.95',
    note: 'Issuer fee for mailing a physical replacement. Replacements due to expiration are free.',
  },
  {
    label: 'Inactivity fee',
    value: '$2.50 / month',
    note: 'Applied by the issuer to the remaining balance after the 6th month following activation. Spend the balance within six months and you pay nothing.',
  },
];

const LIMITS = [
  { label: 'Minimum order', value: '$1.00' },
  { label: 'Maximum card balance', value: '$10,000' },
  { label: 'Max transaction', value: '$5,000' },
  { label: 'Max per day', value: '$5,000' },
];

const FAQ = [
  {
    q: 'How can cards be free?',
    a: 'Cards402 makes money on volume discounts we negotiate with our card suppliers. When an agent buys a $25 card, we settle with the supplier at a rate slightly below $25 and pass the full face value through to the agent. We break even on every individual card and profit on aggregate flow. No surprise markup.',
  },
  {
    q: 'Do I pay Stellar network fees?',
    a: 'Yes — Stellar charges a baseline fee of 0.00001 XLM (roughly a hundredth of a cent) per transaction. Your agent wallet pays it directly. Cards402 never touches it.',
  },
  {
    q: 'What does "$2.00 + 2%" actually look like?',
    a: 'A €50 purchase in Paris on a $200 USD card settles at ~$54 depending on the Visa network rate, plus $2.00 + $1.08 (2% of $54) = a $3.08 foreign transaction fee added on top.',
  },
  {
    q: 'Why is there a 6-month inactivity fee?',
    a: 'This is a standard Pathward reward-card term. The card itself does not expire — only the fee-free window does. If your agent uses the balance within six months (most do), you never encounter it. If the balance sits for longer, $2.50 is deducted each month until it reaches zero.',
  },
  {
    q: 'Can I get a refund?',
    a: "If an order fails before the card is issued, the USDC/XLM you paid is automatically refunded to your sender address. Once a card is issued, the funds sit on the card — we can't reverse them, but your agent can spend them.",
  },
];

// FAQPage structured data — Google uses this to surface FAQ rich
// results directly in the SERP. Keep the mainEntity array in sync
// with the FAQ array above.
const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: {
      '@type': 'Answer',
      text: f.a,
    },
  })),
};

// Product schema for the pricing page itself. Positions Cards402 as
// a free service in Google's SERP UI when price filters are active.
const productJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Cards402 — Virtual Visa cards for AI agents',
  description:
    'Non-custodial virtual Visa card issuance for autonomous agents. Cards sold at face value, settled in USDC or XLM on Stellar.',
  brand: { '@type': 'Brand', name: 'Cards402' },
  offers: {
    '@type': 'Offer',
    url: 'https://cards402.com/pricing',
    priceCurrency: 'USD',
    price: '0.00',
    priceValidUntil: '2099-12-31',
    availability: 'https://schema.org/InStock',
    eligibleRegion: { '@type': 'Place', name: 'Worldwide' },
  },
};

export default function PricingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([faqJsonLd, productJsonLd]),
        }}
      />
      <PageHero
        eyebrow="Pricing"
        title="Cards at face value. No"
        accent="markup"
        intro="Every Cards402 order settles exactly 1:1 against the card's USD face value. There is no subscription, no signup fee, and no per-transaction surcharge from us. The only fees you'll ever see are the ones the card issuer charges directly — listed in full below."
      />

      {/* Fee table */}
      <PageSection>
        <div className="pricing-fee-grid">
          {FEE_ROWS.map((row) => (
            <div key={row.label} className={`pricing-fee-tile ${row.highlight ? 'is-free' : ''}`}>
              <div className="type-eyebrow" style={{ fontSize: '0.6rem', marginBottom: '0.9rem' }}>
                {row.label}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(1.65rem, 2.8vw + 0.3rem, 2.25rem)',
                  fontWeight: 400,
                  letterSpacing: '-0.025em',
                  lineHeight: 1,
                  color: row.highlight ? 'var(--green)' : 'var(--fg)',
                  marginBottom: '0.9rem',
                }}
              >
                {row.value}
              </div>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.82rem',
                  lineHeight: 1.6,
                  color: 'var(--fg-muted)',
                  margin: 0,
                }}
              >
                {row.note}
              </p>
            </div>
          ))}
        </div>
      </PageSection>

      {/* Limits + issuer row */}
      <PageSection background="surface">
        <div
          style={{
            display: 'grid',
            gap: '3rem',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            alignItems: 'start',
          }}
          className="pricing-limits-grid"
        >
          <div>
            <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1rem' }}>
              Spend limits
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.7rem, 2.8vw + 0.4rem, 2.4rem)',
                color: 'var(--fg)',
                margin: '0 0 1.5rem',
                maxWidth: 480,
              }}
            >
              The card is a real Visa. Limits match.
            </h2>
            <p
              className="type-body"
              style={{ maxWidth: 500, fontSize: '0.95rem', marginBottom: '2rem' }}
            >
              Reward cards are bound by the Pathward cardholder agreement. These are the numbers
              your agent needs to plan against.
            </p>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '1rem',
              }}
            >
              {LIMITS.map((l) => (
                <div
                  key={l.label}
                  style={{
                    padding: '1.15rem 1.1rem',
                    border: '1px solid var(--border)',
                    background: 'var(--bg)',
                    borderRadius: 12,
                  }}
                >
                  <div
                    className="type-eyebrow"
                    style={{ fontSize: '0.58rem', marginBottom: '0.55rem' }}
                  >
                    {l.label}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '1.1rem',
                      color: 'var(--fg)',
                      fontWeight: 500,
                    }}
                  >
                    {l.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              padding: '2rem 1.85rem',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 14,
            }}
          >
            <div className="type-eyebrow" style={{ color: 'var(--fg-dim)', marginBottom: '1rem' }}>
              Card issuer
            </div>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '1.5rem',
                fontWeight: 500,
                color: 'var(--fg)',
                margin: '0 0 0.75rem',
                letterSpacing: '-0.02em',
              }}
            >
              Pathward, N.A. · Member FDIC
            </h3>
            <p
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: '0.86rem',
                lineHeight: 1.65,
                color: 'var(--fg-muted)',
                margin: '0 0 1rem',
              }}
            >
              Every Cards402 card is a Visa Reward Card issued by Pathward, N.A. pursuant to a
              license from Visa U.S.A. Inc. Cards are subject to the standard Pathward cardholder
              agreement.
            </p>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: '0 0 1.25rem',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.74rem',
                color: 'var(--fg-muted)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.35rem',
              }}
            >
              <li>Card network · Visa</li>
              <li>Card type · Non-reloadable reward</li>
              <li>Cash access · None (no ATM, no cashback)</li>
              <li>Recurring charges · Not permitted by issuer</li>
            </ul>
            <Link href="/legal/cardholder-agreement" className="link-arrow">
              Full cardholder agreement
            </Link>
          </div>
        </div>
      </PageSection>

      {/* FAQ */}
      <PageSection eyebrow="Common questions" title="Pricing, in plain English.">
        <div
          style={{
            display: 'grid',
            gap: '0',
            borderTop: '1px solid var(--border)',
          }}
        >
          {FAQ.map((f) => (
            <details
              key={f.q}
              className="pricing-faq"
              style={{
                padding: '1.4rem 0.25rem',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  listStyle: 'none',
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.15rem',
                  fontWeight: 500,
                  letterSpacing: '-0.015em',
                  color: 'var(--fg)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                }}
              >
                {f.q}
                <span
                  className="pricing-faq-chevron"
                  aria-hidden
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '1rem',
                    color: 'var(--fg-dim)',
                    transition: 'transform 0.4s var(--ease-out)',
                    flexShrink: 0,
                  }}
                >
                  +
                </span>
              </summary>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.92rem',
                  lineHeight: 1.7,
                  color: 'var(--fg-muted)',
                  margin: '0.9rem 0 0',
                  maxWidth: 680,
                }}
              >
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </PageSection>

      {/* Final CTA */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 920,
            margin: '0 auto',
            padding: '3rem 2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--green-border)',
            borderRadius: 16,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div className="radial-green-glow" aria-hidden style={{ opacity: 0.2 }} />
          <div style={{ position: 'relative' }}>
            <div
              className="type-eyebrow"
              style={{ color: 'var(--green)', marginBottom: '0.85rem' }}
            >
              Ready when you are
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.6rem, 3vw + 0.5rem, 2.4rem)',
                color: 'var(--fg)',
                margin: '0 0 1.5rem',
                maxWidth: 620,
              }}
            >
              The first card is two API calls away.
            </h2>
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
                5-minute quickstart →
              </Link>
              <Link
                href="/dashboard"
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
                Create an API key
              </Link>
            </div>
          </div>
        </div>
      </section>

      <style>{`
        .pricing-fee-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 1px;
          background: var(--border);
          border: 1px solid var(--border);
          border-radius: 14px;
          overflow: hidden;
        }
        .pricing-fee-tile {
          padding: 1.85rem 1.5rem;
          background: var(--bg);
          transition: background 0.4s var(--ease-out);
        }
        .pricing-fee-tile.is-free {
          background: var(--surface);
        }
        .pricing-fee-tile:hover {
          background: var(--surface);
        }
        .pricing-faq summary::-webkit-details-marker { display: none; }
        .pricing-faq[open] .pricing-faq-chevron { transform: rotate(45deg); }

        @media (max-width: 820px) {
          .pricing-limits-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </>
  );
}
