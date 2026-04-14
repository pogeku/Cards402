import type { Metadata } from 'next';
import Link from 'next/link';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

const POST_URL =
  'https://cards402.com/blog/claim-codes-credentials-that-never-touch-the-transcript';
const POST_DATE = '2026-04-14';

export const metadata: Metadata = {
  title: 'Claim codes: credentials that never touch the transcript',
  description:
    'Why Cards402 onboards agents with single-use claim codes instead of raw API keys, the threat model, and how the exchange flow avoids credential-in-prompt failure.',
  alternates: { canonical: POST_URL },
  openGraph: ogForPage({
    title: 'Claim codes: credentials that never touch the transcript — Cards402',
    description:
      'Single-use claim codes instead of raw API keys for agent onboarding. The threat model, the exchange, and why it matters when the operator is talking to an LLM.',
    path: '/blog/claim-codes-credentials-that-never-touch-the-transcript',
  }),
  twitter: twitterForPage({
    title: 'Claim codes: credentials that never touch the transcript',
    description:
      'Why Cards402 onboards agents with single-use claim codes instead of raw API keys.',
  }),
};

const blogJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  '@id': POST_URL,
  mainEntityOfPage: POST_URL,
  headline: 'Claim codes: credentials that never touch the transcript',
  description: 'Why Cards402 onboards agents with single-use claim codes instead of raw API keys.',
  datePublished: POST_DATE,
  dateModified: POST_DATE,
  author: { '@type': 'Organization', name: 'Cards402', url: 'https://cards402.com' },
  publisher: {
    '@type': 'Organization',
    name: 'Cards402',
    logo: { '@type': 'ImageObject', url: 'https://cards402.com/icon.png' },
  },
  image: 'https://cards402.com/opengraph-image',
  keywords:
    'claim code, onboarding, security, threat model, llm transcript, credential, one-time code',
};

const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Blog', item: 'https://cards402.com/blog' },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Claim codes: credentials that never touch the transcript',
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
            Security · Onboarding
          </div>
          <h1
            className="type-display"
            style={{
              fontSize: 'clamp(1.95rem, 4vw + 0.5rem, 3.3rem)',
              color: 'var(--fg)',
              margin: '0 0 1.15rem',
              lineHeight: 0.98,
            }}
          >
            Claim codes: credentials that never touch the transcript.
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
            <span>7 min read</span>
            <span>·</span>
            <span>by Cards402 engineering</span>
          </div>
        </header>

        <div className="post-body">
          <p className="lede">
            The first version of Cards402 onboarded agents the same way every API has onboarded
            developers since the early 2000s: an operator copies a raw API key out of the dashboard
            and pastes it into the agent. When the agent in question is an LLM, this turns out to be
            a terrible idea for reasons that aren&apos;t obvious until you&apos;ve watched an
            operator do it. Claim codes are the fix — a one-time secret that can be pasted safely
            because it becomes worthless the moment the agent redeems it.
          </p>

          <h2>The failure mode</h2>

          <p>
            Picture an operator using a Claude Desktop or Cursor agent to set up a new Cards402
            integration. They mint an API key in the dashboard, copy it to their clipboard, and
            paste it into the conversation with the assistant. The assistant stores it, builds the
            integration, and does something correct with it.
          </p>

          <p>
            The key is now <strong>in the conversation transcript</strong>. That transcript is
            probably persisted locally. It may be synced to the provider&apos;s servers for chat
            history. It might be quoted in a bug report when the operator screenshots the
            conversation. It might end up in a vector store as part of a RAG index the operator
            didn&apos;t remember setting up. It will almost certainly show up in any future
            conversation that references "last week&apos;s chat".
          </p>

          <p>
            Once a long-lived credential enters a transcript, it&apos;s effectively public. You have
            to rotate it, and you have to rotate every such credential every time anyone screenshots
            anything. That&apos;s not a workflow — that&apos;s a continuous revocation incident.
          </p>

          <h2>The constraint</h2>

          <p>
            Agent onboarding has a real constraint that developer onboarding doesn&apos;t: the
            credential has to arrive on the agent&apos;s side without the agent&apos;s operator
            <em> ever</em> seeing it in readable form, because the operator is going to paste
            whatever they see into an LLM chat.
          </p>

          <p>
            You can&apos;t just tell the operator to &ldquo;handle the credential
            out-of-band&rdquo;. &ldquo;Out of band&rdquo; is the band an LLM operator is already in.
            The fix has to be structural: whatever the operator copies has to either be
            safe-to-paste or transparently worthless.
          </p>

          <h2>What we looked at</h2>

          <p>Three options got serious consideration:</p>

          <p>
            <strong>OAuth.</strong> Agents initiate a device-code flow, operator approves it in a
            browser, no credential ever leaves our server. This is the right answer for long-lived
            web apps. It was the wrong answer for Cards402 because the agent doesn&apos;t have a
            browser — it runs in an MCP server or a headless script — and because device-code flows
            add a multi- minute human-in-the-loop step to what should be a one-command setup.
          </p>

          <p>
            <strong>Environment variables only.</strong> Tell operators never to paste the key into
            the conversation, only into their shell&apos;s environment. This is what every API docs
            site tells you to do today. It doesn&apos;t work. The operator will paste it into the
            chat the first time they hit any setup issue and ask the agent for help. We tested this
            with real users; the &ldquo;don&apos;t paste&rdquo; instruction has about a 15% success
            rate.
          </p>

          <p>
            <strong>Short-lived exchange tokens.</strong> Mint a one-time code that the agent
            redeems for a real API key on first startup. The operator only ever sees the code; the
            real credential never exists in a place they can copy. This is what we shipped.
          </p>

          <h2>The claim-code flow</h2>

          <p>
            A claim code is a string that looks like <code>c402_</code> followed by hex characters.
            Three properties:
          </p>

          <ol>
            <li>
              <strong>Single-use.</strong> The first redemption atomically transitions the row from
              unused to used, and the real API key is sealed so it can never be re-extracted even
              with database access later.
            </li>
            <li>
              <strong>Short TTL.</strong> Claim codes expire by default — an operator who mints one
              and forgets about it can&apos;t leave a usable credential sitting around indefinitely.
            </li>
            <li>
              <strong>Worthless after redemption.</strong> Even if the claim ends up in a chat
              transcript that&apos;s backed up to a vector store forever, re-pasting it later gets
              an <code>invalid_claim</code> error. There&apos;s nothing to rotate.
            </li>
          </ol>

          <p>
            The operator runs <code>cards402 onboard --claim c402_...</code> exactly once, inside
            the agent&apos;s runtime. The CLI trades the claim for the real API key over HTTPS,
            writes the key to <code>~/.cards402/config.json</code> with 0600 permissions, and asks
            the agent to confirm its setup before the flow is complete. The operator never sees the
            real API key — it doesn&apos;t leave the backend until it&apos;s written to disk on the
            agent&apos;s machine.
          </p>

          <h2>The transcript-safe property</h2>

          <p>
            The whole design hinges on a simple property: any secret the operator is going to paste
            into the LLM chat has to become worthless within seconds of being generated. Claim codes
            have exactly that property, because redemption happens as part of onboarding and the
            claim is atomically consumed on first use.
          </p>

          <p>
            In the worst case — the operator mints a claim, posts a screenshot to Twitter, and an
            attacker sees it before the agent redeems it — the attacker has a narrow window to race
            the legitimate agent to the backend. They win, they steal an API key; the agent loses
            and has to re-mint. But that race is visible (the operator sees &ldquo;claim already
            redeemed&rdquo; the moment their agent tries), so the fallout is bounded: one re-mint,
            one revocation, and an operator who has now learned not to screenshot live claims.
          </p>

          <p>
            Compare that to the raw-key failure mode: an attacker who scrapes a key from a
            transcript has indefinite use of it until someone independently notices something wrong.
          </p>

          <h2>What else it unlocks</h2>

          <p>
            Building the claim-code primitive turned out to have side benefits we didn&apos;t design
            for:
          </p>

          <ul>
            <li>
              <strong>Labels flow through.</strong> The claim row carries metadata the operator
              picked — a label, a spend limit, an optional webhook URL. That metadata is attached to
              the real API key the instant it&apos;s minted, so the dashboard shows the correct
              label from the first second the agent is alive. No &ldquo;rename your key after
              creating it&rdquo; step.
            </li>
            <li>
              <strong>Agent state lights up immediately.</strong> The backend flips the key&apos;s
              state to <code>initializing</code> the instant the claim redeems, so the dashboard
              onboarding modal progresses even before the agent&apos;s own heartbeat lands. Claim
              redemption is itself a trusted first milestone.
            </li>
            <li>
              <strong>Sealed payloads.</strong> The sealed claim row carries not just the api key
              but also the webhook secret and any other per-agent secrets an operator configured
              up-front. Everything an agent needs to be fully set up is in one transactional
              exchange.
            </li>
          </ul>

          <h2>What this doesn&apos;t solve</h2>

          <p>Claim codes solve the onboarding problem. They do not solve:</p>

          <ul>
            <li>
              <strong>Ongoing agent compromise.</strong> Once an agent has the real API key on disk,
              a compromise of the agent machine gives the attacker the key. That&apos;s a separate
              problem; the fix is short-lived API keys with refresh, which is on the roadmap.
            </li>
            <li>
              <strong>Operator who copy-pastes the config file.</strong> If an operator opens{' '}
              <code>~/.cards402/config.json</code> and pastes the contents into the LLM chat,
              we&apos;re back to the original failure mode. We can&apos;t structurally prevent this,
              only make it obviously silly.
            </li>
            <li>
              <strong>Long-tail key rotation.</strong> Claim codes onboard once. They don&apos;t
              rotate keys for long-running agents. The dashboard revoke-and-reissue flow is the
              manual backup, and the roadmap has automated rotation.
            </li>
          </ul>

          <h2>The broader lesson</h2>

          <p>
            Every piece of infrastructure built for humans has at least one assumption that breaks
            when the &ldquo;user&rdquo; is an LLM operating on behalf of a human. Raw API keys
            aren&apos;t insecure — they&apos;re insecure when the operator is going to paste them
            into a transcript. Webhooks aren&apos;t fragile — they&apos;re fragile when the receiver
            is behind consumer NAT. Polling isn&apos;t slow — it&apos;s slow when every poll burns a
            rate-limit slot for data the caller already has.
          </p>

          <p>
            Cards402 is the result of auditing each of those assumptions one at a time and fixing
            them structurally. Claim codes fix the onboarding one. The other two we&apos;ve covered
            in <Link href="/blog/sse-beats-polling-for-agent-apis">why SSE beats polling</Link> and{' '}
            <Link href="/blog/non-custodial-card-issuance-on-soroban">
              non-custodial card issuance on Soroban
            </Link>
            .
          </p>

          <p>
            If you&apos;re thinking about agent onboarding and would like to compare notes, email{' '}
            <a href="mailto:security@cards402.com">security@cards402.com</a>. We read every one.
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
          .post-body em {
            font-style: italic;
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
