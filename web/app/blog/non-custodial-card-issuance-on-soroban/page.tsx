import type { Metadata } from 'next';
import Link from 'next/link';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

const POST_URL = 'https://cards402.com/blog/non-custodial-card-issuance-on-soroban';
const POST_DATE = '2026-04-14';

export const metadata: Metadata = {
  title: 'How we built non-custodial card issuance on Soroban',
  description:
    'Why Cards402 agents pay the receiver contract directly on Stellar, and how the backend watches on-chain events instead of touching customer funds.',
  alternates: { canonical: POST_URL },
  openGraph: ogForPage({
    title: 'How we built non-custodial card issuance on Soroban — Cards402',
    description:
      'Agents pay a Soroban receiver contract directly. Cards402 observes on-chain events and brokers fulfilment — funds never pass through our wallets.',
    path: '/blog/non-custodial-card-issuance-on-soroban',
  }),
  twitter: twitterForPage({
    title: 'How we built non-custodial card issuance on Soroban',
    description:
      'Agents pay the receiver contract directly. Cards402 watches on-chain events and brokers fulfilment.',
  }),
};

const blogJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  '@id': POST_URL,
  mainEntityOfPage: POST_URL,
  headline: 'How we built non-custodial card issuance on Soroban',
  description:
    'Why Cards402 agents pay the receiver contract directly on Stellar, and how the backend watches on-chain events instead of touching customer funds.',
  datePublished: POST_DATE,
  dateModified: POST_DATE,
  author: { '@type': 'Organization', name: 'Cards402', url: 'https://cards402.com' },
  publisher: {
    '@type': 'Organization',
    name: 'Cards402',
    logo: { '@type': 'ImageObject', url: 'https://cards402.com/icon.png' },
  },
  image: 'https://cards402.com/opengraph-image',
  keywords: 'stellar, soroban, non-custodial, architecture, receiver contract, watcher',
};

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
      name: 'How we built non-custodial card issuance on Soroban',
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
            Architecture · Stellar + Soroban
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
            How we built non-custodial card issuance on Soroban.
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
            <span>10 min read</span>
            <span>·</span>
            <span>by Cards402 engineering</span>
          </div>
        </header>

        <div className="post-body">
          <p className="lede">
            The first version of Cards402 was custodial. An agent would send USDC to a
            Cards402-controlled Stellar wallet, the backend would watch the ledger for deposits,
            match them to an open order, and fulfil the card. Simple, well-understood, and wrong for
            the use case. This post is the walk-through of how and why we moved to a Soroban
            receiver contract the agents pay directly — with no intermediate custody at any point in
            the flow.
          </p>

          <h2>The problem with custodial card issuance</h2>
          <p>
            A custodial pipeline has two specific failure modes that don&apos;t exist in the
            non-custodial version, and both are existential for a payment platform aimed at
            autonomous agents.
          </p>

          <p>
            <strong>First, the custody window.</strong> From the moment an agent sends funds to our
            wallet until the moment those funds are consumed to issue a card, we are a bank. A small
            bank with one customer, but a bank. That has every regulatory consequence you expect:
            money transmitter licensing, fiduciary responsibilities, rebuilt from scratch every
            jurisdiction. We wanted to build infrastructure, not a bank.
          </p>

          <p>
            <strong>Second, the trust model.</strong> An agent that signs a payment to a custodial
            wallet is trusting the wallet operator to honour a commitment (&ldquo;if I receive X, I
            will trigger Y&rdquo;). That commitment is off-chain. The agent has no cryptographic
            guarantee that Y will happen — only a promise from the operator and some amount of
            reputation at stake. For an agent that&apos;s going to place thousands of these orders
            autonomously, a reputation check that relies on &ldquo;surely they wouldn&apos;t do
            that&rdquo; is not a security property.
          </p>

          <h2>What Soroban changes</h2>
          <p>
            Soroban is Stellar&apos;s smart-contract layer. The primitives it gives us that standard
            Stellar payments don&apos;t:
          </p>

          <ul>
            <li>
              A contract can accept native XLM or any Stellar Asset Contract (SAC) token as part of
              its invocation parameters.
            </li>
            <li>
              Contract events are emitted on every invocation and are replayable from ledger state.
              A watcher that listens for events can reconstruct the full history deterministically,
              without trusting the contract operator to tell it what happened.
            </li>
            <li>
              Events carry structured topics. We can tag every deposit with the{' '}
              <code>order_id</code> so the backend knows exactly which Cards402 order the deposit
              belongs to — no heuristics, no memo field parsing, no timing windows to reconcile.
            </li>
          </ul>

          <h2>The receiver contract</h2>
          <p>The Cards402 receiver contract has two entry points:</p>

          <ul>
            <li>
              <code>pay_usdc(order_id, amount)</code> — accepts USDC via a SAC transfer and emits a{' '}
              <code>pay_usdc</code> event tagged with the order id.
            </li>
            <li>
              <code>pay_xlm(order_id, amount)</code> — same shape, accepts native XLM.
            </li>
          </ul>

          <p>
            There&apos;s no <code>withdraw</code>. There&apos;s no <code>owner</code>. There&apos;s
            no upgrade path. The contract holds funds only for as long as it takes the backend to
            pull them out into the treasury wallet — and the backend has no special authority over
            the contract beyond what any Stellar address has. If the backend disappeared tomorrow,
            the deposits sitting in the contract would remain exactly where they are, attributable
            to their order ids, recoverable via any ledger-reading tool.
          </p>

          <p>
            When an agent calls <code>pay_usdc()</code>, three things happen atomically in a single
            Stellar transaction:
          </p>

          <ol>
            <li>USDC is transferred from the agent&apos;s account to the contract.</li>
            <li>
              An event is emitted with <code>topic[0] = &ldquo;pay_usdc&rdquo;</code>,{' '}
              <code>topic[1] = order_id</code>, and <code>value = amount (micro-USDC i128)</code>.
            </li>
            <li>
              The transaction&apos;s <code>txHash</code> is returned to the agent and stored in its
              local order state.
            </li>
          </ol>

          <p>Everything after that point is the watcher&apos;s job.</p>

          <h2>The watcher</h2>
          <p>
            The watcher is a small Node.js process that streams events from the receiver contract
            via the Soroban RPC. We&apos;d looked at bridging through Horizon first — classic
            Stellar payment events — but Soroban contract events are a richer primitive: they carry
            the structured topics we use for order routing, and they&apos;re replayable from any
            ledger height.
          </p>

          <p>
            For every <code>pay_usdc</code> or <code>pay_xlm</code> event, the watcher:
          </p>

          <ol>
            <li>
              Parses the order id out of <code>topic[1]</code>.
            </li>
            <li>
              Looks up the matching Cards402 order row. If the order doesn&apos;t exist, we push the
              event to an <code>unmatched_payments</code> queue for manual review — that queue has
              been used exactly once in production, and it was a test payment.
            </li>
            <li>
              Compares the deposited amount to the quoted amount. USDC is an exact match; XLM is
              checked against the quote captured at order creation. Amount mismatches also go to the
              unmatched queue — never auto-credited and never auto-refunded to a wrong address.
            </li>
            <li>
              On a clean match, atomically transitions the order from
              <code>pending_payment</code> to <code>ordering</code> and kicks off Stage 1
              fulfilment.
            </li>
          </ol>

          <p>
            The critical property is that{' '}
            <strong>the watcher is a decoration, not a trust anchor.</strong> If the watcher crashes
            for an hour and misses a bunch of events, the Soroban RPC still has them — the watcher
            catches up on restart by replaying from the last-processed ledger height. If the watcher
            is replaced tomorrow with a different implementation (say, a Rust rewrite), it
            doesn&apos;t matter: the ledger is the source of truth for every deposit.
          </p>

          <h2>How the refund story works</h2>
          <p>
            The natural question about a non-custodial system is &ldquo;what happens when fulfilment
            fails?&rdquo; In a custodial system, you just reverse the transfer on your books. Here
            the money has already left the agent wallet — it sits in the receiver contract or has
            been swept into the treasury.
          </p>

          <p>
            The answer is that{' '}
            <strong>refunds are separate outbound Stellar payments, not reversed deposits</strong>.
            When an order fails, the backend moves it to <code>refund_pending</code>, looks up the
            agent&apos;s sender address from the original event, and submits a new Stellar payment
            from the Cards402 treasury wallet back to the agent. The refund transaction hash lands
            on the order row as <code>refund.stellar_txid</code>, which any integrator can verify
            on-chain.
          </p>

          <p>
            This means the refund path depends on the treasury being solvent. If our treasury runs
            dry, refunds queue and the owner gets a loud alert. It&apos;s not the same strong
            guarantee as custody — but the blast radius is bounded by how much the treasury can
            hold, and customers can verify live that we aren&apos;t over-committed. The balance is
            on-chain and public. We&apos;re considering a proof-of-reserves dashboard but
            haven&apos;t shipped it yet; for now, check{' '}
            <Link href="/status">status.cards402.com</Link> and the security page for the treasury
            public key.
          </p>

          <h2>What this buys us</h2>
          <p>Four concrete benefits:</p>

          <ol>
            <li>
              <strong>No money transmitter exposure</strong> for the inbound side. We don&apos;t
              take agent deposits onto our books at any point.
            </li>
            <li>
              <strong>Ledger-verifiable history.</strong> Every agent interaction is a Stellar
              transaction. Any integrator can reconcile their own order history against the public
              ledger without trusting Cards402 data at all.
            </li>
            <li>
              <strong>Graceful degradation.</strong> If the backend goes down mid-flight, the
              deposit sits in the receiver contract, attributable to its order id, waiting.
              There&apos;s no state we could lose that would leave funds stranded — only orders that
              would be slow.
            </li>
            <li>
              <strong>Blast radius containment.</strong> A compromise of the Cards402 backend
              can&apos;t drain agent wallets. The worst case is the treasury balance being spent
              against the wrong refund recipients — which is loud, on-chain, and bounded.
            </li>
          </ol>

          <h2>What we gave up</h2>
          <p>Three things the custodial version did better:</p>

          <ul>
            <li>
              <strong>Latency on the first ledger.</strong> A Stellar ledger closes every ~5
              seconds. The custodial model had us batching deposits in seconds anyway, but the
              receiver-contract path gives us a hard 5s floor we can&apos;t reduce.
            </li>
            <li>
              <strong>Gas overhead.</strong> Soroban contract invocations are pricier than native
              payments. The marginal cost to an agent is a fraction of a cent, but multiplied by a
              busy agent it adds up.
            </li>
            <li>
              <strong>Upgrade flexibility.</strong> A custodial address is just a key — you can
              rotate it. A contract is code, and we can&apos;t upgrade the receiver contract without
              redeploying and migrating every open order. We traded flexibility for the guarantee
              that a compromised key can&apos;t rewrite the flow.
            </li>
          </ul>

          <p>
            The trade was worth it for us — non-custodial was the premise of the product, not a
            feature — but the trade is real.
          </p>

          <h2>Further reading</h2>
          <p>
            If you want the actual on-chain details, the Soroban docs at{' '}
            <a
              href="https://developers.stellar.org/docs/learn/smart-contract-internals/events"
              target="_blank"
              rel="noreferrer"
            >
              developers.stellar.org
            </a>{' '}
            cover the event model we rely on. The Cards402-side details are in{' '}
            <Link href="/docs">the API reference</Link> (specifically the &ldquo;Create order&rdquo;
            and &ldquo;Stream order&rdquo; sections), and the companion blog post{' '}
            <Link href="/blog/anatomy-of-a-cards402-order">Anatomy of a Cards402 order</Link> walks
            through the full 33-second timeline in the other direction — from the agent&apos;s first
            API call through to the card landing.
          </p>

          <p>
            Questions on this? Email <a href="mailto:api@cards402.com">api@cards402.com</a>. We read
            every one.
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
