import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, PageSection } from '@/app/components/MarketingPage';
import { ogForPage, twitterForPage } from '@/app/lib/seo';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How Cards402 secures API keys, payments, and infrastructure. Non-custodial by design, hashed keys, signed webhooks, and a responsible-disclosure policy.',
  alternates: { canonical: 'https://cards402.com/security' },
  openGraph: ogForPage({
    title: 'Security — Cards402',
    description: 'Non-custodial by design. Hashed keys. Signed webhooks. Responsible disclosure.',
    path: '/security',
  }),
  twitter: twitterForPage({
    title: 'Security — Cards402',
    description: 'Non-custodial by design. Responsible disclosure.',
  }),
};

const PILLARS = [
  {
    eyebrow: 'Custody',
    title: 'Non-custodial by architecture.',
    body: 'Agents pay the Soroban receiver contract directly. Cards402 never holds funds — we observe on-chain events and broker fulfilment. If Cards402 disappeared tomorrow, nothing is trapped in our custody, because nothing is in our custody.',
  },
  {
    eyebrow: 'Keys',
    title: 'Hashed at rest. Scoped at the edge.',
    body: 'API keys are bcrypt-hashed with per-key salt before they touch the database. We can verify a key against the hash on request; we cannot recover the plaintext. A short key prefix is stored alongside the hash as an O(1) lookup index, so auth stays constant-time under load. Keys are scoped to USDC spend limits and can be revoked in one click from the dashboard.',
  },
  {
    eyebrow: 'Onboarding',
    title: 'Claim codes instead of raw keys.',
    body: "The cards402 CLI mints single-use claim codes so operators never paste API keys into LLM context. The claim is exchanged for a key on the agent's machine, over TLS, and invalidated after use. No credential lives in the transcript.",
  },
  {
    eyebrow: 'Webhooks',
    title: 'HMAC signed, replay protected.',
    body: 'Outgoing webhooks carry X-Cards402-Signature (HMAC-SHA256 over timestamp + body) and X-Cards402-Timestamp. The documented client reference rejects anything older than five minutes. Webhook secrets rotate automatically on key revocation.',
  },
  {
    eyebrow: 'Circuit breaker',
    title: 'Fail-closed on the upstream.',
    body: 'The fulfilment pipeline has a three-strike circuit breaker. After three consecutive upstream failures we freeze new orders and return 503 until an operator manually unfreezes. This stops cascading failures from draining agent wallets against a broken pipe.',
  },
  {
    eyebrow: 'Infrastructure',
    title: 'One region. Audited root access.',
    body: 'Cards402 runs on encrypted VPS instances in a single EU data centre (Vultr Frankfurt). SSH keys are hardware-backed. The database runs SQLite in WAL journal mode for crash-consistent durability, and snapshot backups are taken on a scheduled cadence. Every root-shell session is recorded and reviewed.',
  },
];

const POSTURE = [
  { label: 'TLS', value: 'TLS 1.3 minimum · HSTS preloaded' },
  { label: 'Transport', value: 'Strict same-site cookies · CSRF on every mutation' },
  { label: 'Keys at rest', value: 'bcrypt · per-key salt · 12-char lookup index' },
  { label: 'Database', value: 'SQLite · WAL mode · scheduled snapshot backup' },
  { label: 'Agent keys', value: 'OWS encrypted vault file · 0600 · optional passphrase' },
  { label: 'Stellar signer', value: 'Hardware wallet only for treasury ops' },
];

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title="Secure by architecture, not by"
        accent="trust"
        intro="Cards402 is a small team running financial infrastructure. Everything below is a design choice, not a marketing bullet — we picked these specifically so a single compromise of any one component never exposes customer funds or credentials."
      />

      {/* Pillars */}
      <PageSection>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))',
            gap: '0',
            borderTop: '1px solid var(--border)',
            borderLeft: '1px solid var(--border)',
          }}
        >
          {PILLARS.map((p) => (
            <article
              key={p.title}
              className="security-tile"
              style={{
                padding: '2rem 1.85rem 2.35rem',
                borderRight: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                position: 'relative',
              }}
            >
              <div
                className="type-eyebrow"
                style={{ fontSize: '0.6rem', marginBottom: '1rem', color: 'var(--green)' }}
              >
                {p.eyebrow}
              </div>
              <h3
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.35rem',
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
                  fontSize: '0.88rem',
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

      {/* Security posture table */}
      <PageSection background="surface" eyebrow="Posture" title="The technical specifics.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
            maxWidth: 960,
          }}
        >
          {POSTURE.map((p) => (
            <div
              key={p.label}
              style={{
                padding: '1.15rem 1.2rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 12,
              }}
            >
              <div
                className="type-eyebrow"
                style={{ fontSize: '0.58rem', marginBottom: '0.55rem' }}
              >
                {p.label}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.82rem',
                  color: 'var(--fg)',
                  lineHeight: 1.5,
                }}
              >
                {p.value}
              </div>
            </div>
          ))}
        </div>
      </PageSection>

      {/* Responsible disclosure */}
      <PageSection eyebrow="Disclosure" title="Found something? Tell us. We'll pay.">
        <div style={{ maxWidth: 720 }}>
          <p className="type-body" style={{ fontSize: '0.98rem', marginBottom: '1.5rem' }}>
            Cards402 operates a responsible-disclosure programme. If you find a vulnerability, email{' '}
            <a
              href="mailto:security@cards402.com"
              style={{
                color: 'var(--fg)',
                borderBottom: '1px solid var(--green-border)',
                textDecoration: 'none',
              }}
            >
              security@cards402.com
            </a>{' '}
            with reproduction steps. We acknowledge within 24 hours, triage within 72, and publish a
            postmortem to{' '}
            <Link
              href="/changelog"
              style={{
                color: 'var(--fg)',
                borderBottom: '1px solid var(--green-border)',
                textDecoration: 'none',
              }}
            >
              /changelog
            </Link>{' '}
            once the fix is live.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1rem',
              marginBottom: '2rem',
            }}
          >
            {[
              { label: 'Critical', value: 'Up to $5,000' },
              { label: 'High', value: '$1,000' },
              { label: 'Medium', value: '$250' },
              { label: 'Low', value: 'Hall of fame' },
            ].map((t) => (
              <div
                key={t.label}
                style={{
                  padding: '1.1rem',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  background: 'var(--surface)',
                }}
              >
                <div
                  className="type-eyebrow"
                  style={{ fontSize: '0.58rem', marginBottom: '0.4rem' }}
                >
                  {t.label}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1.15rem',
                    color: 'var(--fg)',
                    fontWeight: 500,
                  }}
                >
                  {t.value}
                </div>
              </div>
            ))}
          </div>

          <p className="type-body" style={{ fontSize: '0.86rem', color: 'var(--fg-dim)' }}>
            Out of scope: social engineering, volumetric DoS, physical attacks, anything requiring
            root access to our treasury wallet. Public disclosure is embargoed until a fix ships.
          </p>
        </div>
      </PageSection>

      <style>{`
        .security-tile::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 0;
          height: 2px;
          background: var(--green);
          transition: width 0.6s var(--ease-out);
        }
        .security-tile:hover::before {
          width: 44px;
        }
      `}</style>
    </>
  );
}
