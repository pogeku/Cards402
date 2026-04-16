import type { Metadata } from 'next';
import Link from 'next/link';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

const POST_URL = 'https://cards402.com/blog/what-we-found-auditing-our-own-code';
const POST_DATE = '2026-04-16';

export const metadata: Metadata = {
  title: 'What we found auditing our own code',
  description:
    '~95 commits in two days: treasury-loss races, silent auth bypasses, circuit breaker defeats, and 550 new tests. A walkthrough of the worst bugs and the patterns they share.',
  alternates: { canonical: POST_URL },
  openGraph: ogForPage({
    title: 'What we found auditing our own code — Cards402',
    description:
      '~95 commits in two days: treasury-loss races, auth bypasses, circuit breaker defeats, and 550 new tests.',
    path: '/blog/what-we-found-auditing-our-own-code',
  }),
  twitter: twitterForPage({
    title: 'What we found auditing our own code',
    description:
      '~95 commits in two days: treasury-loss races, auth bypasses, circuit breaker defeats, and 550 new tests.',
  }),
};

const blogJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  '@id': POST_URL,
  mainEntityOfPage: POST_URL,
  headline: 'What we found auditing our own code',
  description:
    '~95 commits in two days: treasury-loss races, silent auth bypasses, circuit breaker defeats, and 550 new tests.',
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
    logo: { '@type': 'ImageObject', url: 'https://cards402.com/icon.png' },
  },
  image: 'https://cards402.com/opengraph-image',
  keywords: 'security audit, sqlite, stellar, soroban, defense in depth',
};

const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Blog', item: 'https://cards402.com/blog' },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'What we found auditing our own code',
      item: POST_URL,
    },
  ],
};

const s = {
  h2: {
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(1.4rem, 2.5vw, 1.8rem)',
    color: 'var(--fg)',
    margin: '3.5rem 0 1.25rem',
    lineHeight: 1.15,
  } as const,
  h3: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.1rem',
    color: 'var(--fg)',
    margin: '2.5rem 0 0.75rem',
    lineHeight: 1.25,
  } as const,
};

export default function BlogPost() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([blogJsonLd, breadcrumbJsonLd]) }}
      />
      <article style={{ maxWidth: 720, margin: '0 auto', padding: '4.5rem 1.35rem 6rem' }}>
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
            Engineering · Security
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
            What we found auditing our own code.
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
            <span>12 min read</span>
            <span>·</span>
            <span>by Cards402 engineering</span>
          </div>
        </header>

        <div className="post-body">
          <p className="lede">
            We ran a systematic adversarial audit of the entire Cards402 codebase over two days.
            Every source file in the backend, every security-critical module in the SDK, the web
            frontend. ~95 commits. The backend test suite went from 488 to 1,038. Here is what we
            found, why it was there, and the three patterns that kept recurring.
          </p>

          <h2 style={s.h2}>The shape of the audit</h2>
          <p>
            The method was simple: pick a file, read it adversarially, find a real bug, fix it,
            write a regression test, run the full suite, commit. Then pick the next file. No
            time-boxing per file, no prioritisation by &ldquo;risk score&rdquo; &mdash; just a
            linear sweep of every module with enough logic to hide a bug.
          </p>
          <p>
            The backend has 46 source files. 42 were modified with fixes. The remaining four are
            either dead code (zero callers), static data (a hardcoded merchant catalog), or
            middleware that was already clean and got test coverage from an adjacent cycle. The SDK
            has 12 source files; every one with meaningful logic was audited.
          </p>

          <h2 style={s.h2}>The worst bugs</h2>

          <h3 style={s.h3}>1. Treasury-loss race in the reconciler</h3>
          <p>
            The reconciler&rsquo;s hard-fail path did an unconditional{' '}
            <code>UPDATE orders SET status=&apos;failed&apos; WHERE id = ?</code>. Between the
            reconciler&rsquo;s SELECT and that UPDATE, the VCC callback handler could atomically
            claim the same row as <code>delivered</code>, store the card, and fire the delivery
            webhook. The reconciler&rsquo;s unconditional UPDATE then overwrote{' '}
            <code>delivered</code> with <code>failed</code> and called <code>scheduleRefund</code>.
          </p>
          <p>
            The agent got both the card <em>and</em> a refund. Treasury drained on every order
            caught in the window. The fix was the same atomic-claim pattern the VCC callback handler
            already used: <code>WHERE status = &apos;ordering&apos;</code> + check{' '}
            <code>changes === 0</code>. Two sites needed it &mdash; both the retry-based reconciler
            and the VCC-poll recovery path.
          </p>

          <h3 style={s.h3}>2. Refund ignoring overpayment</h3>
          <p>
            When an agent overpays (common &mdash; agents round up for safety), the delta is tracked
            in <code>order.excess_usdc</code>. But the refund path sent only{' '}
            <code>order.amount_usdc</code> &mdash; the quoted amount. Every failed overpaid order
            silently kept the excess. The fix sums both columns in BigInt stroop precision
            (Stellar&rsquo;s native 7-decimal representation) and refunds the total.
          </p>

          <h3 style={s.h3}>3. API key that never expires</h3>
          <p>
            The expiry check was <code>new Date(candidate.expires_at) &lt; new Date()</code>. If{' '}
            <code>expires_at</code> was corrupt (bad ISO string, ops typo), <code>new Date()</code>{' '}
            returned <code>Invalid Date</code>, and <code>NaN &lt; number</code> evaluates to{' '}
            <code>false</code> in JavaScript. The key silently never expired. Fix parses through{' '}
            <code>getTime()</code>, requires <code>Number.isFinite</code>, and fails closed.
          </p>

          <h3 style={s.h3}>4. Hardcoded mainnet URLs and issuers</h3>
          <p>
            The funding-check poller, the Soroban <code>submitSorobanTx</code> Horizon fallback, and
            the <code>getOWSBalance</code> helper all had the Circle mainnet USDC issuer and Horizon
            URL hardcoded instead of reading from the environment. Cards402 runs on mainnet in both
            production and development, so this wasn&rsquo;t causing live failures &mdash; but the
            code was fragile: if anyone ever deployed against testnet for integration testing, USDC
            funding detection would silently break and the SDK&rsquo;s Horizon fallback would return
            false &ldquo;dropped&rdquo; signals. We made all three env-configurable for consistency
            with the rest of the codebase (which already reads <code>STELLAR_USDC_ISSUER</code> and{' '}
            <code>STELLAR_NETWORK</code> from env).
          </p>

          <h2 style={s.h2}>Three recurring patterns</h2>
          <p>
            After ~95 fixes, the bugs cluster into three families. Recognising the pattern makes it
            easier to spot the next instance before it ships.
          </p>

          <h3 style={s.h3}>Pattern 1: &ldquo;Node gives you string | string[]&rdquo;</h3>
          <p>
            Node&rsquo;s HTTP parser returns an array for duplicated headers. Most code assumes a
            string. We found this bug in <strong>seven</strong> independent call sites:{' '}
            <code>requireAuth</code>, <code>/auth/me</code>, <code>/auth/logout</code>,{' '}
            <code>recordAuditFromReq</code>, <code>recordAudit</code> (direct callers),{' '}
            <code>vcc-callback</code> audit rows, and the app-level <code>X-Request-ID</code>{' '}
            middleware. Each one crashed to 500 or silently dropped a row. The durable fix is to
            validate at the library boundary (<code>recordAudit</code> now coerces internally)
            rather than auditing every caller.
          </p>

          <h3 style={s.h3}>Pattern 2: &ldquo;The catch block can&rsquo;t crash&rdquo;</h3>
          <p>
            JavaScript lets you <code>throw null</code>, <code>throw &apos;string&apos;</code>, or
            throw an Error whose <code>.message</code> getter itself throws. Any{' '}
            <code>catch(err)</code> that reads <code>err.message</code> without a guard will crash
            on its own error-handling path. We found this in the payment handler (left orders wedged
            in <code>ordering</code> status with no refund), the retry helper (ran only one attempt
            instead of three), and the sanitize-error module (the error sanitiser itself threw). The
            pattern: extract a <code>safeErrorMessage(err)</code> helper that handles null,
            undefined, strings, getter-thrown messages, and revoked Proxies.
          </p>

          <h3 style={s.h3}>Pattern 3: &ldquo;The circuit breaker has a race&rdquo;</h3>
          <p>
            Both the VCC client and the webhook delivery layer had the same in-flight-success race:
            a request that started before the breaker tripped could complete successfully during
            cooldown and call <code>recordSuccess()</code>, which unconditionally zeroed{' '}
            <code>openedUntil</code>. The next caller saw an open gate and hit the still-broken
            upstream. Fix: leave <code>openedUntil</code> alone while{' '}
            <code>Date.now() &lt; openedUntil</code>; zero the failure counter unconditionally so
            the next post-cooldown window starts fresh.
          </p>

          <h2 style={s.h2}>By the numbers</h2>
          <div style={{ overflowX: 'auto', margin: '1.5rem 0' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
              }}
            >
              <tbody>
                {[
                  ['Commits', '~95'],
                  ['Backend files modified', '42 / 46'],
                  ['SDK files audited', '10 / 12'],
                  ['Backend tests before', '~488'],
                  ['Backend tests after', '1,038'],
                  ['Treasury-safety fixes', '3'],
                  ['Auth / identity fixes', '7'],
                  ['Circuit breaker fixes', '3'],
                  ['Silent-error-loss fixes', '8'],
                  ['Testnet-correctness fixes', '3'],
                  ['DoS-from-config fixes', '4'],
                ].map(([label, value]) => (
                  <tr key={label} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.6rem 1rem 0.6rem 0', color: 'var(--fg-muted)' }}>
                      {label}
                    </td>
                    <td style={{ padding: '0.6rem 0', color: 'var(--fg)', textAlign: 'right' }}>
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 style={s.h2}>What the audit did not cover</h2>
          <p>
            This was a source-code audit, not a pentest. We didn&rsquo;t test the live deployment
            (infrastructure, TLS termination, Cloudflare rules, DNS), the VCC scraper service
            (separate codebase), the Soroban receiver contract (needs a specialist cryptographic
            review), or dependency supply-chain integrity. We also didn&rsquo;t load-test the SQLite
            write path under genuine multi-connection pressure &mdash; we added{' '}
            <code>PRAGMA busy_timeout</code> to close the obvious gap, but the real proof requires
            sustained concurrent traffic. Those are the next steps.
          </p>

          <h2 style={s.h2}>The full list</h2>
          <p>
            Every fix has a detailed commit message with the pre-fix code, the exploit scenario, and
            the rationale for the specific defense. The{' '}
            <Link href="/changelog" style={{ color: 'var(--green)' }}>
              changelog
            </Link>{' '}
            has the categorised summary; the git log has the per-finding detail.
          </p>
        </div>
      </article>
    </>
  );
}
