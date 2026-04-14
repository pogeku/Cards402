import type { Metadata } from 'next';
import Link from 'next/link';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

const POST_URL = 'https://cards402.com/blog/sse-beats-polling-for-agent-apis';
const POST_DATE = '2026-04-14';

export const metadata: Metadata = {
  title: 'Why SSE beats polling for agent-facing APIs',
  description:
    'Server-Sent Events are almost always the right primitive for long-lived order tracking with autonomous agents. Latency, reconnects, and why we default to SSE.',
  alternates: { canonical: POST_URL },
  openGraph: ogForPage({
    title: 'Why SSE beats polling for agent-facing APIs — Cards402',
    description:
      'Server-Sent Events are almost always the right primitive for long-lived order tracking with autonomous agents.',
    path: '/blog/sse-beats-polling-for-agent-apis',
  }),
  twitter: twitterForPage({
    title: 'Why SSE beats polling for agent-facing APIs',
    description:
      'Server-Sent Events are almost always the right primitive for long-lived order tracking with autonomous agents.',
  }),
};

const blogJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  '@id': POST_URL,
  mainEntityOfPage: POST_URL,
  headline: 'Why SSE beats polling for agent-facing APIs',
  description:
    'Server-Sent Events are almost always the right primitive for long-lived order tracking with autonomous agents.',
  datePublished: POST_DATE,
  dateModified: POST_DATE,
  author: { '@type': 'Organization', name: 'Cards402', url: 'https://cards402.com' },
  publisher: {
    '@type': 'Organization',
    name: 'Cards402',
    logo: { '@type': 'ImageObject', url: 'https://cards402.com/icon.png' },
  },
  image: 'https://cards402.com/opengraph-image',
  keywords: 'sse, server-sent events, polling, long-lived http, agent api, fallback',
};

const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Blog', item: 'https://cards402.com/blog' },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Why SSE beats polling for agent-facing APIs',
      item: POST_URL,
    },
  ],
};

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

        <header style={{ marginBottom: '3rem' }}>
          <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1rem' }}>
            Engineering · API design
          </div>
          <h1
            className="type-display"
            style={{
              fontSize: 'clamp(2rem, 4vw + 0.5rem, 3.3rem)',
              color: 'var(--fg)',
              margin: '0 0 1.15rem',
              lineHeight: 0.98,
            }}
          >
            Why SSE beats polling for agent-facing APIs.
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
            <span>6 min read</span>
            <span>·</span>
            <span>by Cards402 engineering</span>
          </div>
        </header>

        <div className="post-body">
          <p className="lede">
            When Cards402 launched, <code>GET /v1/orders/:id</code> was the only way to watch an
            order. It worked — poll every few seconds until <code>phase: &quot;ready&quot;</code>{' '}
            showed up — and it was the wrong primitive for agents. This post explains why we default
            to Server-Sent Events now, why we kept the polling endpoint as a fallback rather than
            deleting it, and the little backpressure quirks that matter when your clients are
            long-lived processes instead of browsers.
          </p>

          <h2>The three-option question</h2>

          <p>
            When a client needs to observe a long-running server-side job, there are basically three
            families of answers:
          </p>

          <ol>
            <li>
              <strong>Poll.</strong> The client hits a read endpoint on a timer. Simple,
              cache-friendly, stateless.
            </li>
            <li>
              <strong>Push to a webhook.</strong> The server calls the client back when something
              changes.
            </li>
            <li>
              <strong>Stream over one long-lived connection.</strong> The client opens a connection
              and the server writes updates to it until a terminal event.
            </li>
          </ol>

          <p>
            We looked at all three seriously. The requirements that broke the decision for us were
            specific to the agent audience: agents that create dozens or hundreds of orders per day,
            run as long-lived processes (not request/response apps), and often run behind consumer
            NAT where hosting an inbound webhook endpoint is awkward at best.
          </p>

          <h2>Why polling loses</h2>

          <p>Polling has three failure modes that bite agents harder than they bite browsers:</p>

          <p>
            <strong>Latency is a choice you&apos;re always making wrong.</strong> Poll every second,
            and you&apos;re burning two HTTP round-trips per second for a job that might finish in
            the next 30 seconds. Poll every ten seconds and your median &ldquo;time to know&rdquo;
            is 5 seconds slower than the underlying pipeline. There&apos;s no right interval;
            there&apos;s only a trade-off you pick at call time with no visibility into how long the
            job will actually take.
          </p>

          <p>
            <strong>Rate limits and polling are adversaries.</strong> A well-behaved poll loop on a
            busy agent ends up being the biggest fraction of our rate-limit traffic, burning slots
            for reads that mostly return the same state you already knew. You can widen the limit,
            but then the limit stops protecting you from the misbehaving clients you built it for.
          </p>

          <p>
            <strong>Resumption is manual.</strong> Agent crashes mid-poll, comes back, and has to
            rediscover which orders were still in flight. Either you persist the order list locally
            and walk it, or you hit a <code>GET /v1/orders</code> list endpoint and fan out a poll
            per in-flight order. Fine in small numbers, obnoxious once the agent has fifty
            concurrent orders.
          </p>

          <h2>Why webhooks also lose (for this audience)</h2>

          <p>
            Webhooks solve the latency and the rate-limit problems. They introduce a different set:
          </p>

          <p>
            <strong>You have to host an endpoint.</strong> For an agent running on a laptop, a cloud
            function without inbound HTTP, or a Claude Desktop extension, &ldquo;just spin up a
            public HTTPS listener&rdquo; is a real barrier. The agents that can host one usually can
            poll. The ones that can&apos;t poll usually can&apos;t host one either.
          </p>

          <p>
            <strong>Delivery semantics need work.</strong> Cards402 webhooks are retried with
            exponential backoff (30s, 5m, 30m), signed with HMAC, and require the receiver to be
            idempotent. That&apos;s absolutely the right design — see the{' '}
            <Link href="/docs#webhooks">webhooks section of /docs</Link> for the details — but
            it&apos;s a lot of code for an agent developer to write correctly just to watch one
            order.
          </p>

          <p>
            <strong>Webhook-first agents don&apos;t compose.</strong> The moment you have two agents
            running on the same machine each needing their own inbound URL, you start building a
            routing layer. At three agents you start writing a load balancer. That&apos;s
            infrastructure the agent author shouldn&apos;t be building.
          </p>

          <h2>Why SSE fits</h2>

          <p>
            Server-Sent Events solve the problems with polling without creating the problems with
            webhooks:
          </p>

          <ul>
            <li>
              <strong>One open connection.</strong> No round-trips, no rate-limit pressure, no
              latency negotiation. The server pushes on every state change.
            </li>
            <li>
              <strong>Outbound-only.</strong> The agent opens the connection. No inbound HTTP
              listener, no routing infrastructure, no NAT-punch required. Works the same on a laptop
              and in a Lambda.
            </li>
            <li>
              <strong>Resumable.</strong> Every SSE event from Cards402 carries the full current
              state as its <code>data:</code> payload — not a delta. A client that reconnects always
              sees the latest phase on the first message, without needing <code>Last-Event-ID</code>{' '}
              replay. If the agent crashes mid- order, it just re-opens the stream and gets the
              current state.
            </li>
            <li>
              <strong>Plain HTTP.</strong> Works through every proxy, CDN, and load balancer that
              already passes regular HTTP responses. No WebSocket upgrade, no sticky-session
              requirement.
            </li>
          </ul>

          <h2>The fallback story</h2>

          <p>
            We did not delete the polling endpoint when we added SSE. We kept it and made it the
            fallback path in <code>client.waitForCard()</code>: the SDK tries SSE first, and if the{' '}
            <code>text/event-stream</code> header is stripped in transit — which happens more often
            than you&apos;d think behind corporate proxies, some CDN caching configurations, and at
            least one specific enterprise egress gateway we don&apos;t want to name — it silently
            falls back to polling.
          </p>

          <p>
            This matters because SSE dependencies travel poorly. A customer who tests their
            integration in dev against our real SSE stream and then deploys into a production
            environment with a corporate proxy can find themselves with a broken integration they
            didn&apos;t write. The SDK handling both under one surface means their code doesn&apos;t
            care.
          </p>

          <p>
            The fallback poll interval defaults to 3 seconds — faster than you&apos;d normally pick,
            because we&apos;re only paying for it when the primary path is unavailable and the
            customer probably has a user-visible timeout they&apos;re fighting against. The whole
            point of the fallback is to degrade gracefully; we want it to hurt a little so we know
            when it&apos;s firing.
          </p>

          <h2>Operational details</h2>

          <p>A few things we had to get right for SSE to work reliably in practice:</p>

          <ul>
            <li>
              <strong>
                <code>: keepalive</code> every 15 seconds.
              </strong>{' '}
              SSE comments are normally stripped at the server boundary, but intermediate proxies
              idle-kill long-lived connections after anywhere from 30 seconds to a few minutes of no
              bytes moving. Writing <code>: keepalive</code> every 15s keeps the socket warm in
              every production path we&apos;ve tested.
            </li>
            <li>
              <strong>
                <code>X-Accel-Buffering: no</code>.
              </strong>{' '}
              Tells nginx to pass bytes through instead of buffering until the response completes.
              Without this, you can have a perfectly functional stream that still arrives at the
              client in one batch after the terminal event fires.
            </li>
            <li>
              <strong>Terminal event closes the stream.</strong> After <code>ready</code>,{' '}
              <code>failed</code>, <code>refunded</code>, <code>rejected</code>, or{' '}
              <code>expired</code>, we write the final event and immediately close. Don&apos;t make
              clients guess when to stop listening.
            </li>
            <li>
              <strong>Full state on reconnect.</strong> Every event includes the full order state,
              not just the delta. A naive client that reconnects without any tracking state still
              sees the current phase on its first message. This is the feature that makes SSE
              strictly cheaper than polling for the common case — a reconnect is exactly one
              message.
            </li>
          </ul>

          <h2>What we gave up</h2>

          <p>Three things polling did better:</p>

          <ul>
            <li>
              <strong>Cacheability.</strong> A poll hits a GET endpoint with a cacheable body. An
              SSE stream is never cacheable because it&apos;s a streaming response. For agents this
              almost never matters, but it&apos;s the reason most public APIs ship poll first and
              stream later.
            </li>
            <li>
              <strong>Operator debuggability.</strong> A poll loop leaves nice even stripes in the
              access log. An SSE connection is a single request that might be open for 90 seconds
              with bytes written in the middle — existing log analysis tools don&apos;t always know
              what to do with it. We had to build purpose-built dashboards.
            </li>
            <li>
              <strong>Connection budget.</strong> Every SSE connection holds a server thread / event
              loop slot open. At our current volume it&apos;s cheap; at 100×, we&apos;ll need to
              pick whether to move the SSE termination to an edge component or multiplex inside the
              existing Node process.
            </li>
          </ul>

          <h2>When you should still use polling</h2>

          <p>
            If you&apos;re integrating Cards402 and for whatever reason SSE isn&apos;t available — a
            framework that makes streaming responses hard, a corporate proxy that fingerprints and
            blocks long-lived connections, a test environment where you&apos;d rather not manage
            socket lifetimes — <code>GET /v1/orders/:id</code> is a first-class supported path, not
            a deprecated fallback. The <Link href="/docs">docs</Link> documents both. You can mix
            them freely.
          </p>

          <p>
            But if you&apos;re writing new agent code today, default to SSE (or just use{' '}
            <code>purchaseCardOWS()</code>, which picks for you). You&apos;ll spend less time on the
            timing logic and your agent will know about terminal events a few seconds sooner than
            the polling version ever could.
          </p>

          <h2>Related</h2>

          <p>
            The technical walk-through of the receiver contract and watcher is at{' '}
            <Link href="/blog/non-custodial-card-issuance-on-soroban">
              non-custodial card issuance on Soroban
            </Link>
            , the 33-second timeline of a full order is at{' '}
            <Link href="/blog/anatomy-of-a-cards402-order">anatomy of a Cards402 order</Link>, and
            the full API reference for the SSE endpoint is in the{' '}
            <Link href="/docs#stream-order">stream section of /docs</Link>.
          </p>
        </div>

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
              New posts cross-post to the changelog.{' '}
              <Link
                href="/changelog/feed.xml"
                style={{
                  color: 'var(--fg)',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--green-border)',
                }}
              >
                RSS feed →
              </Link>
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
          .post-body ul,
          .post-body ol {
            font-family: var(--font-body);
            font-size: 1rem;
            line-height: 1.75;
            color: var(--fg-muted);
            padding-left: 1.3rem;
            margin: 0 0 1.35rem;
          }
          .post-body ul li,
          .post-body ol li {
            margin-bottom: 0.6rem;
          }
          .post-body a:not(.link-arrow) {
            color: var(--fg);
            text-decoration: none;
            border-bottom: 1px solid var(--green-border);
          }
        `}</style>
      </article>
    </>
  );
}
