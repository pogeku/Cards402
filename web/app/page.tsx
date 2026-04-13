// Cards402 landing page.
//
// Editorial refined minimalism: Fraunces display, IBM Plex Sans body,
// Plex Mono for data. Hero is a drawn-constellation + floating card
// silhouette. Every section aims for two information moments per view
// maximum — restraint, not density.

import Link from 'next/link';
import { HeroScene, HeroCard } from '@/app/components/HeroCard';

const agentOneLiner = `Read https://cards402.com/skill.md and set up
this agent by running:

  npx cards402 onboard --claim c402_<code>`;

const purchaseSnippet = `import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY,
  walletName: 'my-agent',
  amountUsdc: '25.00',
});

// { number, cvv, expiry, brand, order_id }`;

const METRICS = [
  { label: 'Time to card', value: '≈60s', sub: 'pay → PAN' },
  { label: 'Network', value: 'Stellar', sub: 'mainnet' },
  { label: 'Custody', value: 'None', sub: 'agent pays direct' },
  { label: 'Pricing', value: 'Face value', sub: 'no fees' },
];

const FLOW = [
  {
    num: '01',
    title: 'Create order',
    body: 'POST /v1/orders with a USD amount. Backend returns a Soroban receiver-contract ID and a one-time order_id.',
  },
  {
    num: '02',
    title: 'Sign one transaction',
    body: 'Agent invokes pay_usdc (or pay_xlm) on the receiver contract. USDC-first, with a DEX-routed path payment to settle the quote.',
  },
  {
    num: '03',
    title: 'Watcher + fulfillment',
    body: 'The Soroban watcher picks up the payment event, validates the amount against the quote, and kicks fulfillment. Mismatches go to an unmatched-payments queue.',
  },
  {
    num: '04',
    title: 'Real Visa card',
    body: 'PAN / CVV / expiry stream back over the original HTTP connection. One SSE stream, no webhooks to host, no polling required.',
  },
];

const FEATURES = [
  {
    eyebrow: 'Stellar-native',
    title: 'One transaction in, one card out',
    body: 'Every purchase is a single `PathPaymentStrictReceive`. USDC or XLM. No redirect, no hosted checkout, no user session.',
  },
  {
    eyebrow: 'Zero custody',
    title: 'Agents pay the contract directly',
    body: 'Cards402 never holds customer funds. The agent signs with its own OWS wallet; the backend only observes on-chain events and brokers fulfillment.',
  },
  {
    eyebrow: 'Made for autonomy',
    title: 'One-shot claim codes, not shared keys',
    body: 'Operators mint a single-use claim instead of pasting raw API keys into agent context. Credentials never hit the conversation transcript.',
  },
  {
    eyebrow: 'Engineering surface',
    title: 'MCP, HTTP, SSE — pick your integration',
    body: 'Drop the Cards402 MCP server into Claude Desktop, hit the REST API from any runtime, or subscribe to the SSE phase stream for live updates.',
  },
];

export default function Home() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section
        style={{
          position: 'relative',
          paddingTop: '6.5rem',
          paddingBottom: '7rem',
          paddingLeft: '1.35rem',
          paddingRight: '1.35rem',
          overflow: 'hidden',
        }}
      >
        {/* Scene is a full-bleed backdrop painting starfield + conic
            holographic wash + halo across the entire hero section. */}
        <HeroScene />
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)',
            gap: '3rem',
            alignItems: 'center',
            position: 'relative',
            zIndex: 2,
          }}
          className="hero-grid"
        >
          <div>
            <div
              className="type-eyebrow animate-reveal"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.55rem',
                animationDelay: '0.05s',
              }}
            >
              <span
                className="pulse-green"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--green)',
                  boxShadow: '0 0 12px var(--green-glow)',
                }}
              />
              Live on Stellar mainnet
            </div>

            <h1
              className="type-display animate-reveal"
              style={{
                marginTop: '1.5rem',
                marginBottom: '1.6rem',
                fontSize: 'clamp(2.6rem, 6vw + 0.5rem, 5.2rem)',
                color: 'var(--fg)',
                animationDelay: '0.15s',
              }}
            >
              Virtual Visa cards,
              <br />
              issued to{' '}
              <span
                style={{
                  fontStyle: 'italic',
                  fontVariationSettings: '"opsz" 144, "SOFT" 80',
                  color: 'var(--green)',
                }}
              >
                agents
              </span>
              .
            </h1>

            <p
              className="type-body animate-reveal"
              style={{
                maxWidth: 560,
                fontSize: '1.05rem',
                color: 'var(--fg-muted)',
                marginBottom: '2rem',
                animationDelay: '0.3s',
              }}
            >
              One Stellar transaction in, one real card number out. Agents pay in USDC or XLM and
              get a usable PAN in about sixty seconds — no signup, no KYC, no custody, no human in
              the loop.
            </p>

            <div
              className="animate-reveal"
              style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                animationDelay: '0.45s',
              }}
            >
              <Link
                href="/docs"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.55rem',
                  padding: '0.85rem 1.35rem',
                  borderRadius: 999,
                  background: 'var(--fg)',
                  color: 'var(--bg)',
                  textDecoration: 'none',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  letterSpacing: '-0.005em',
                  transition: 'transform 0.4s var(--ease-out), box-shadow 0.4s var(--ease-out)',
                }}
                className="cta-primary"
              >
                Read the docs
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  aria-hidden
                  style={{ opacity: 0.7, display: 'block' }}
                >
                  <path
                    d="M2 7h10m-3.5-3.5L12 7l-3.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
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
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.88rem',
                  fontWeight: 500,
                  transition: 'background 0.4s var(--ease-out), border-color 0.4s var(--ease-out)',
                }}
                className="cta-secondary"
              >
                Open dashboard
              </Link>
            </div>
          </div>

          {/* Card flows with the grid: right column on desktop,
              wraps below the text on tablet + mobile. */}
          <div className="hero-art">
            <HeroCard />
          </div>
        </div>
      </section>

      {/* ── Metric row ───────────────────────────────────────────── */}
      <section
        style={{
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: '2rem 1.35rem',
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '2rem',
          }}
        >
          {METRICS.map((m) => (
            <div key={m.label}>
              <div className="type-eyebrow" style={{ fontSize: '0.62rem', marginBottom: '0.7rem' }}>
                {m.label}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(1.75rem, 3vw + 0.4rem, 2.4rem)',
                  fontWeight: 400,
                  letterSpacing: '-0.025em',
                  lineHeight: 1,
                  color: 'var(--fg)',
                  marginBottom: '0.35rem',
                }}
              >
                {m.value}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                  color: 'var(--fg-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                {m.sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Flow ─────────────────────────────────────────────────── */}
      <section
        style={{
          padding: '7rem 1.35rem 5rem',
          position: 'relative',
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
          }}
        >
          <div className="type-eyebrow" style={{ marginBottom: '1.5rem', color: 'var(--green)' }}>
            The flow
          </div>
          <h2
            className="type-display-tight"
            style={{
              maxWidth: 820,
              fontSize: 'clamp(2rem, 4vw + 0.5rem, 3.5rem)',
              marginBottom: '4rem',
              color: 'var(--fg)',
            }}
          >
            Four steps, zero human touchpoints. Fast enough that agents don&apos;t need to batch.
          </h2>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '1.25rem',
            }}
          >
            {FLOW.map((step, i) => (
              <article
                key={step.num}
                style={{
                  position: 'relative',
                  padding: '1.75rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 14,
                  transition:
                    'transform 0.5s var(--ease-out), border-color 0.5s var(--ease-out), box-shadow 0.5s var(--ease-out)',
                }}
                className="flow-step"
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.68rem',
                    color: 'var(--green)',
                    letterSpacing: '0.12em',
                    marginBottom: '1.35rem',
                  }}
                >
                  {step.num}
                </div>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.35rem',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: 'var(--fg)',
                    marginTop: 0,
                    marginBottom: '0.8rem',
                    lineHeight: 1.1,
                  }}
                >
                  {step.title}
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
                  {step.body}
                </p>
                {i < FLOW.length - 1 && (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      right: -1,
                      top: '50%',
                      width: 18,
                      height: 1,
                      background: 'var(--border-strong)',
                      display: 'none',
                    }}
                  />
                )}
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Code showcase ────────────────────────────────────────── */}
      <section
        style={{
          padding: '5rem 1.35rem 6rem',
          position: 'relative',
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.1fr)',
            gap: '3rem',
            alignItems: 'center',
          }}
          className="code-grid"
        >
          <div>
            <div className="type-eyebrow" style={{ marginBottom: '1.2rem', color: 'var(--green)' }}>
              Integration
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(2rem, 3.5vw + 0.5rem, 3rem)',
                marginBottom: '1.35rem',
                color: 'var(--fg)',
              }}
            >
              Three lines of TypeScript.
            </h2>
            <p
              className="type-body"
              style={{
                fontSize: '1rem',
                maxWidth: 500,
                marginBottom: '2rem',
              }}
            >
              The Cards402 SDK wraps the order → Soroban payment → card-ready cycle behind a single
              call. One SSE stream, no polling, no webhook endpoint to host, resume-safe if the
              agent crashes mid-flight.
            </p>
            <Link href="/docs" className="link-arrow">
              See the full reference
            </Link>
          </div>

          <pre
            style={{
              margin: 0,
              fontSize: '0.78rem',
              lineHeight: 1.7,
              fontFamily: 'var(--font-mono)',
              boxShadow: 'var(--shadow-float)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div
              aria-hidden
              style={{
                position: 'absolute',
                top: 12,
                left: 14,
                display: 'flex',
                gap: 6,
                opacity: 0.5,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.12)',
                }}
              />
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.12)',
                }}
              />
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.12)',
                }}
              />
            </div>
            <code style={{ display: 'block', marginTop: '1.2rem' }}>{purchaseSnippet}</code>
          </pre>
        </div>
      </section>

      {/* ── Feature grid ─────────────────────────────────────────── */}
      <section style={{ padding: '4rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
          }}
        >
          <div className="type-eyebrow" style={{ marginBottom: '1.2rem', color: 'var(--green)' }}>
            Principles
          </div>
          <h2
            className="type-display-tight"
            style={{
              maxWidth: 820,
              fontSize: 'clamp(2rem, 4vw + 0.5rem, 3.25rem)',
              marginBottom: '4rem',
              color: 'var(--fg)',
            }}
          >
            Built like a payment rail. Read like an SDK.
          </h2>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '0',
              borderTop: '1px solid var(--border)',
              borderLeft: '1px solid var(--border)',
            }}
          >
            {FEATURES.map((f) => (
              <article
                key={f.title}
                style={{
                  padding: '2rem 1.85rem 2.5rem',
                  borderRight: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  position: 'relative',
                  transition: 'background 0.5s var(--ease-out)',
                }}
                className="feature-tile"
              >
                <div
                  className="type-eyebrow"
                  style={{
                    fontSize: '0.6rem',
                    marginBottom: '1.2rem',
                    color: 'var(--fg-dim)',
                  }}
                >
                  {f.eyebrow}
                </div>
                <h3
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.3rem',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: 'var(--fg)',
                    marginTop: 0,
                    marginBottom: '0.85rem',
                    lineHeight: 1.12,
                  }}
                >
                  {f.title}
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
                  {f.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Agent onboarding CTA ─────────────────────────────────── */}
      <section style={{ padding: '3rem 1.35rem 6rem' }}>
        <div
          style={{
            maxWidth: 920,
            margin: '0 auto',
            padding: '3rem 2.5rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            position: 'relative',
            overflow: 'hidden',
          }}
          className="final-cta"
        >
          <div className="radial-green-glow" aria-hidden />
          <div style={{ position: 'relative' }}>
            <div
              className="type-eyebrow"
              style={{
                color: 'var(--green)',
                marginBottom: '0.9rem',
              }}
            >
              What the operator hands their agent
            </div>
            <h2
              className="type-display-tight"
              style={{
                fontSize: 'clamp(1.6rem, 3vw + 0.5rem, 2.4rem)',
                color: 'var(--fg)',
                marginTop: 0,
                marginBottom: '1.5rem',
                maxWidth: 720,
              }}
            >
              One paste. No raw keys. No transcript leaks.
            </h2>
            <pre
              style={{
                background: 'var(--bg)',
                fontSize: '0.76rem',
                lineHeight: 1.7,
                marginBottom: '1.8rem',
              }}
            >
              <code>{agentOneLiner}</code>
            </pre>
            <Link href="/docs" className="link-arrow">
              Full onboarding flow
            </Link>
          </div>
        </div>
      </section>

      {/* ── Local styles ─────────────────────────────────────────── */}
      <style>{`
        .cta-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 12px 36px -12px var(--green-glow);
        }
        .cta-secondary:hover {
          background: var(--surface-hover);
          border-color: var(--fg-muted);
        }
        .flow-step:hover {
          transform: translateY(-2px);
          border-color: var(--border-strong);
          box-shadow: var(--shadow-float);
        }
        .feature-tile:hover {
          background: var(--surface);
        }
        .feature-tile::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 0;
          height: 2px;
          background: var(--green);
          transition: width 0.6s var(--ease-out);
        }
        .feature-tile:hover::before {
          width: 32px;
        }
        .final-cta {
          transition: border-color 0.5s var(--ease-out);
        }
        .final-cta:hover {
          border-color: var(--green-border);
        }

        @media (max-width: 860px) {
          .hero-grid {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 2rem !important;
          }
          .hero-art {
            max-width: 480px;
            margin: 0 auto;
          }
          .code-grid {
            grid-template-columns: minmax(0, 1fr) !important;
          }
        }
        @media (max-width: 480px) {
          .final-cta {
            padding: 2rem 1.5rem !important;
          }
          .hero-art {
            display: none;
          }
        }
      `}</style>
    </>
  );
}
