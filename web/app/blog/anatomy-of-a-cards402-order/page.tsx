import type { Metadata } from 'next';
import Link from 'next/link';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

const POST_URL = 'https://cards402.com/blog/anatomy-of-a-cards402-order';
const POST_DATE = '2026-04-14';

export const metadata: Metadata = {
  title: 'Anatomy of a Cards402 order',
  description:
    'Every millisecond of the 33-second path from agent.purchaseCard() to PAN-in-hand. Payment confirmation, Stage 1 scrape, Stage 2 fulfilment, SSE stream, and the failure modes we found along the way.',
  alternates: { canonical: POST_URL },
  openGraph: ogForPage({
    title: 'Anatomy of a Cards402 order — Cards402',
    description: 'Every millisecond of the 33-second path from purchaseCard() to PAN-in-hand.',
    path: '/blog/anatomy-of-a-cards402-order',
  }),
  twitter: twitterForPage({
    title: 'Anatomy of a Cards402 order',
    description: 'Every millisecond of the 33-second path from purchaseCard() to PAN-in-hand.',
  }),
};

// BlogPosting JSON-LD — this is a real dated post, so it gets the
// full posting schema with the organization as publisher. Article
// body is the rendered markup; `articleBody` is a plain-text version
// for crawlers that don't parse HTML well.
const blogJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  '@id': POST_URL,
  mainEntityOfPage: POST_URL,
  headline: 'Anatomy of a Cards402 order',
  description: 'Every millisecond of the 33-second path from agent.purchaseCard() to PAN-in-hand.',
  datePublished: POST_DATE,
  dateModified: POST_DATE,
  author: {
    '@type': 'Organization',
    name: 'Cards402',
    url: 'https://cards402.com',
  },
  publisher: {
    '@type': 'Organization',
    name: 'Cards402',
    logo: {
      '@type': 'ImageObject',
      url: 'https://cards402.com/icon.png',
    },
  },
  image: 'https://cards402.com/opengraph-image',
  keywords: 'stellar, soroban, card issuance, sse, fulfilment pipeline',
};

// Breadcrumb JSON-LD for the post URL.
const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Blog',
      item: 'https://cards402.com/blog',
    },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Anatomy of a Cards402 order',
      item: POST_URL,
    },
  ],
};

// The timeline — every labelled phase the order walks through from
// the moment the operator calls purchaseCardOWS() to the moment the
// PAN lands in the response. Timings come from our median production
// run as of Q2 2026. The table cell style is used twice so we keep
// it extracted.
const TIMELINE: Array<{ t: string; phase: string; detail: string }> = [
  { t: '0 ms', phase: 'purchaseCardOWS() called', detail: 'SDK opens a fetch to POST /v1/orders.' },
  {
    t: '~80 ms',
    phase: 'Order row inserted',
    detail:
      'Backend allocates an order_id, persists the intent in SQLite, and returns the Soroban receiver contract + USDC/XLM quote.',
  },
  {
    t: '~200 ms',
    phase: 'Quote fetched',
    detail:
      'The XLM leg is priced via a live oracle read; USDC is always 1:1. The response is sent back before the watcher even knows the order exists.',
  },
  {
    t: '~250 ms',
    phase: 'SDK signs the payment',
    detail:
      'OWS vault decrypts the Stellar secret in-memory, builds the contract invocation (pay_usdc or pay_xlm), and submits via the Soroban RPC.',
  },
  {
    t: '~5 s',
    phase: 'Stellar ledger commit',
    detail:
      "Average ledger close time on mainnet. The Stellar RPC returns the txHash as soon as it's committed.",
  },
  {
    t: '~5.1 s',
    phase: 'Watcher event',
    detail:
      'Our Soroban watcher subscribes to the receiver contract and fires on the deposit event. The event carries the order_id as a topic, so we know exactly which order it belongs to.',
  },
  {
    t: '~5.2 s',
    phase: 'Amount reconciliation',
    detail:
      'We compare the deposited amount to the quoted amount. Mismatches go to an unmatched-payments queue for manual review; matches move the order into processing.',
  },
  {
    t: '~5.3 s',
    phase: 'Stage 1 kicks off',
    detail:
      'The fulfilment worker picks up the order and starts the Stage 1 Selenium scrape against the upstream card supplier. CAPTCHA solving runs in parallel.',
  },
  {
    t: '~22 s',
    phase: 'Stage 1 done',
    detail:
      'Upstream issues the card number and CVV. The worker writes them encrypted to a holding row and moves the order to stage1_done.',
  },
  {
    t: '~27 s',
    phase: 'Stage 2 kicks off',
    detail:
      'Stage 2 verifies the card is live and activates it if needed. This is where most failures show up — the pipeline retries once before giving up.',
  },
  {
    t: '~32 s',
    phase: 'Stage 2 done',
    detail:
      'The card is active. We move the order to delivered and emit an SSE event with the full card object.',
  },
  {
    t: '~33 s',
    phase: 'SSE event received',
    detail:
      'The SDK’s waitForCard() picks up the event and resolves the original promise with { number, cvv, expiry, brand, order_id }. The agent is back in its loop with a usable PAN.',
  },
];

export default function BlogPost() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([blogJsonLd, breadcrumbJsonLd]),
        }}
      />
      <article
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: '4.5rem 1.35rem 6rem',
        }}
      >
        {/* Back-to-blog link */}
        <Link
          href="/blog"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            color: 'var(--fg-dim)',
            textDecoration: 'none',
            marginBottom: '1.75rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          ← Blog
        </Link>

        {/* Header */}
        <header style={{ marginBottom: '3rem' }}>
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1rem' }}>
            Engineering · Fulfilment pipeline
          </div>
          <h1
            className="type-display"
            style={{
              fontSize: 'clamp(2.1rem, 4vw + 0.5rem, 3.4rem)',
              color: 'var(--fg)',
              margin: '0 0 1.15rem',
              lineHeight: 0.98,
            }}
          >
            Anatomy of a Cards402 order.
          </h1>
          <div
            style={{
              display: 'flex',
              gap: '1.25rem',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              color: 'var(--fg-dim)',
              flexWrap: 'wrap',
            }}
          >
            <time dateTime={POST_DATE}>
              {new Date(POST_DATE).toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              })}
            </time>
            <span>·</span>
            <span>8 min read</span>
            <span>·</span>
            <span>by Cards402 engineering</span>
          </div>
        </header>

        {/* Body */}
        <div className="post-body">
          <p className="lede">
            Every time an agent calls <code>purchaseCardOWS()</code>, it kicks off a ~33-second
            chain of events that goes through a Stellar RPC, a Soroban smart contract, an event
            watcher, two stages of fulfilment against an upstream card supplier, and a Server-Sent
            Events stream before the PAN comes back. This post walks through every phase of that
            chain with the median timings we see in production today.
          </p>

          <p>
            We&apos;re writing this because &ldquo;how does this actually work&rdquo; is the single
            most common question we get on integration calls — and because the chain is genuinely
            interesting. Payment rails don&apos;t usually have a 30-second end-to-end budget, and
            the fact that Cards402 can hit that reliably is a function of every component in the
            chain being cooperative about latency.
          </p>

          <h2>The 33-second timeline</h2>
          <p>
            Numbers are the P50 from our mainnet traffic in the past two weeks. The P99 is closer to
            75s and is dominated almost entirely by upstream variance in Stage 1.
          </p>

          <div style={{ overflowX: 'auto', margin: '1.5rem 0 2rem' }}>
            <table className="post-table">
              <thead>
                <tr>
                  <th>T+</th>
                  <th>Phase</th>
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {TIMELINE.map((row) => (
                  <tr key={row.phase}>
                    <td>
                      <code>{row.t}</code>
                    </td>
                    <td>
                      <strong>{row.phase}</strong>
                    </td>
                    <td>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Where it tends to fail</h2>
          <p>
            The two dominant failure modes are <strong>Stage 1 scrape timeouts</strong> (usually a
            bot-detection trip on the upstream supplier, usually transient) and{' '}
            <strong>Stage 2 activation errors</strong> (the card was minted but the upstream
            activation endpoint 500&apos;d, which requires a manual poke). Both trip the circuit
            breaker after three consecutive failures — once tripped, new orders return{' '}
            <code>503 service_temporarily_unavailable</code> and funds stop flowing, which is the
            correct fail-closed behaviour for a payment pipeline.
          </p>

          <p>
            We&apos;ve never lost customer funds to a fulfilment failure. The worst case has always
            been &ldquo;order failed, refund queued, money on-chain again within a few
            minutes&rdquo;. The non-custodial architecture is what makes that possible: the agent
            never handed us custody of the USDC or XLM in the first place, so a refund is just a
            regular Stellar payment going the other way.
          </p>

          <h2>Why SSE and not polling</h2>
          <p>
            When Cards402 launched, <code>GET /v1/orders/:id</code> was the only way to watch order
            state. It worked — poll every 3 seconds, eventually see{' '}
            <code>phase: &quot;ready&quot;</code> — but it was a bad fit for agent-facing clients.
            Every poll is a full HTTP round-trip; every round-trip is either too slow (if you back
            off) or too expensive (if you don&apos;t).
          </p>

          <p>
            The SSE stream at <code>/v1/orders/:id/stream</code> replaces all of that with one open
            connection. The server pushes on every phase transition, closes cleanly on the terminal
            phase, and emits an SSE comment every 15 seconds so intermediate proxies don&apos;t
            idle-kill the socket. The SDK&apos;s <code>waitForCard()</code> defaults to SSE and
            silently falls back to polling if the <code>text/event-stream</code> header is stripped
            in transit — which happens more often than you&apos;d think behind corporate proxies.
          </p>

          <h2>What&apos;s next</h2>
          <p>
            Three things we&apos;re working on that would show up in a future version of this post:
          </p>

          <ul>
            <li>
              <strong>Pre-warmed card pool.</strong> For agents that need sub-1s card delivery, we
              can maintain a reserve of minted unclaimed cards and hand them out on-demand. The 33s
              path becomes a 500ms path for the common case.
            </li>
            <li>
              <strong>Multi-supplier routing.</strong> Stage 1 is currently bound to one upstream
              supplier. Routing each order to the best-performing supplier by live inventory would
              drop the P99 significantly.
            </li>
            <li>
              <strong>Retry with alternative supplier on failure.</strong> Today, a Stage 1 failure
              goes to refund. With multiple suppliers, we retry the next one before giving up. Users
              only see failures when every supplier has failed — which should be essentially never.
            </li>
          </ul>

          <p>
            If you&apos;re building on Cards402 and want to dig deeper, the full HTTP API reference
            is at <Link href="/docs">/docs</Link>, the 5-minute quickstart is at{' '}
            <Link href="/docs/quickstart">/docs/quickstart</Link>, and questions go to{' '}
            <a href="mailto:api@cards402.com">api@cards402.com</a>.
          </p>
        </div>

        {/* Next post CTA */}
        <div
          style={{
            marginTop: '4rem',
            paddingTop: '2rem',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1.5rem',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <div
              className="type-eyebrow"
              style={{ color: 'var(--fg-dim)', marginBottom: '0.4rem', fontSize: '0.58rem' }}
            >
              Subscribe
            </div>
            <p
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: '0.88rem',
                color: 'var(--fg-muted)',
                margin: 0,
                maxWidth: 460,
              }}
            >
              New posts cross-post to the changelog. Drop{' '}
              <Link
                href="/changelog/feed.xml"
                style={{
                  color: 'var(--fg)',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--green-border)',
                }}
              >
                the RSS feed
              </Link>{' '}
              into your reader to get every future post and shipped change.
            </p>
          </div>
          <Link
            href="/blog"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.75rem 1.2rem',
              fontFamily: 'var(--font-body)',
              fontSize: '0.82rem',
              fontWeight: 500,
              color: 'var(--fg)',
              background: 'transparent',
              border: '1px solid var(--border-strong)',
              borderRadius: 999,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              alignSelf: 'center',
            }}
          >
            All posts →
          </Link>
        </div>

        <style>{`
          .post-body p {
            font-family: var(--font-body);
            font-size: 1rem;
            line-height: 1.75;
            color: var(--fg-muted);
            margin: 0 0 1.35rem;
          }
          .post-body p.lede {
            font-size: 1.1rem;
            color: var(--fg);
            margin-bottom: 2rem;
          }
          .post-body h2 {
            font-family: var(--font-display);
            font-size: clamp(1.5rem, 2.4vw + 0.3rem, 2rem);
            font-weight: 500;
            letter-spacing: -0.02em;
            color: var(--fg);
            margin: 2.75rem 0 1rem;
            line-height: 1.15;
          }
          .post-body code {
            font-family: var(--font-mono);
            font-size: 0.86em;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 0.1em 0.38em;
            color: var(--green);
          }
          .post-body strong {
            color: var(--fg);
            font-weight: 600;
          }
          .post-body ul {
            font-family: var(--font-body);
            font-size: 1rem;
            line-height: 1.75;
            color: var(--fg-muted);
            padding-left: 1.3rem;
            margin: 0 0 1.35rem;
          }
          .post-body ul li {
            margin-bottom: 0.6rem;
          }
          .post-body a:not(.link-arrow) {
            color: var(--fg);
            text-decoration: none;
            border-bottom: 1px solid var(--green-border);
          }

          .post-table {
            font-family: var(--font-body);
            font-size: 0.86rem;
            min-width: 560px;
          }
          .post-table th {
            font-family: var(--font-mono);
            font-size: 0.62rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--fg-dim);
            text-align: left;
            padding: 0.55rem 0.85rem;
            border-bottom: 1px solid var(--border);
            font-weight: 600;
          }
          .post-table td {
            padding: 0.85rem 0.85rem;
            border-bottom: 1px solid var(--border-hairline);
            color: var(--fg-muted);
            vertical-align: top;
            line-height: 1.6;
          }
          .post-table td code {
            font-family: var(--font-mono);
            font-size: 0.82em;
            color: var(--green);
            white-space: nowrap;
          }
          .post-table td strong {
            color: var(--fg);
            font-weight: 600;
          }
        `}</style>
      </article>
    </>
  );
}
