import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, LegalBody } from '@/app/components/MarketingPage';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    "What Cards402 collects, what it doesn't, who processes it, and how long we keep it. Written in plain English.",
  alternates: { canonical: 'https://cards402.com/privacy' },
};

export default function PrivacyPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal · Privacy"
        title="We collect the minimum, and we tell you"
        accent="what"
        intro="Cards402 is a transaction-processing company. The data we hold is the data we need to reconcile a payment against a card order, plus the bare minimum to sign you in. Nothing else."
      />

      <LegalBody
        intro={
          <>
            <strong>Last updated 14 April 2026.</strong> Cards402 is operated by Cards402 Inc. We
            review this page every time we add a new data processor or change retention policy, and
            we publish changes here before they take effect.
          </>
        }
        sections={[
          {
            heading: 'Summary',
            body: (
              <>
                <ul>
                  <li>
                    We collect your email for authentication, and an optional display name if you
                    set one.
                  </li>
                  <li>
                    We store every API key you mint (hashed, never in plaintext) and every order
                    placed against it.
                  </li>
                  <li>
                    We record the Stellar transaction IDs for every payment so we can reconcile
                    on-chain events against your orders.
                  </li>
                  <li>
                    We do <strong>not</strong> store card PANs, CVVs, or any cardholder PII beyond
                    the point of issuance. Issuance is proxied directly to the card issuer
                    (Pathward, N.A.).
                  </li>
                  <li>
                    We do not sell, rent, or license any customer data to anyone, ever. We never
                    will.
                  </li>
                </ul>
              </>
            ),
          },
          {
            heading: 'What we collect',
            body: (
              <>
                <p>
                  <strong>Account data.</strong> Email address, display name (optional), and
                  timestamp of each login. We use email as the only account identifier — we do not
                  ask for phone numbers, physical addresses, real names, or government IDs.
                </p>
                <p>
                  <strong>API data.</strong> API key metadata (hashed token, label, spend limit,
                  creation and revocation timestamps) and every order placed against the key
                  (amount, timestamps, status, payment asset, Stellar transaction ID, agent-supplied
                  metadata).
                </p>
                <p>
                  <strong>Operational telemetry.</strong> IP address and user agent on API requests,
                  kept for 14 days for abuse detection and rate-limit enforcement, then rotated out.
                </p>
                <p>
                  <strong>Billing data.</strong> Stellar wallet addresses that have paid for orders
                  and the amounts paid. We retain these indefinitely for audit and legal reasons.
                </p>
              </>
            ),
          },
          {
            heading: "What we don't collect",
            body: (
              <>
                <ul>
                  <li>
                    <strong>No cookies for tracking.</strong> The dashboard uses first-party session
                    cookies only. No Google Analytics, no Segment, no Mixpanel, no ad pixels, no
                    third-party trackers of any kind.
                  </li>
                  <li>
                    <strong>No behavioural profiles.</strong> We do not build user profiles, run A/B
                    tests on real users, or share usage patterns with anyone.
                  </li>
                  <li>
                    <strong>No cardholder PII.</strong> Cards are issued by Pathward. Cards402
                    receives the PAN / CVV / expiry at issuance time, streams them to your agent
                    over the order response, and discards them from memory. They are not written to
                    disk on our infrastructure.
                  </li>
                </ul>
              </>
            ),
          },
          {
            heading: 'Who processes your data',
            body: (
              <>
                <p>We use the following sub-processors:</p>
                <ul>
                  <li>
                    <strong>Pathward, N.A.</strong> — card issuance. Receives the order amount at
                    issuance time.
                  </li>
                  <li>
                    <strong>Stellar Development Foundation infrastructure</strong> — the Stellar
                    mainnet itself, where on-chain payment records live permanently and publicly.
                    Cards402 does not control this data and cannot delete it.
                  </li>
                  <li>
                    <strong>Resend</strong> — transactional email delivery (login codes, order
                    notifications). Receives your email address.
                  </li>
                  <li>
                    <strong>Hetzner Cloud</strong> — primary infrastructure provider (EU data
                    centre). Cards402 operates on dedicated cloud instances under our own control.
                  </li>
                </ul>
                <p>
                  We do not use any other sub-processors. If we add one, we update this page first.
                </p>
              </>
            ),
          },
          {
            heading: 'Retention',
            body: (
              <>
                <ul>
                  <li>
                    <strong>Email, API key metadata, orders:</strong> kept while the account is
                    active. On deletion, orders are retained for 2 years for audit, then
                    hard-deleted. Email and API key rows are hard-deleted immediately.
                  </li>
                  <li>
                    <strong>Operational logs (IPs, user agents):</strong> 14-day rolling window.
                  </li>
                  <li>
                    <strong>Stellar transaction records:</strong> retained indefinitely. These are
                    also permanently visible on the Stellar public ledger.
                  </li>
                  <li>
                    <strong>Login codes:</strong> expire 15 minutes after being sent.
                  </li>
                </ul>
              </>
            ),
          },
          {
            heading: 'Your rights',
            body: (
              <>
                <p>
                  If you&apos;re a resident of the EU / UK / California / any jurisdiction with a
                  data rights law, you have the right to:
                </p>
                <ul>
                  <li>Access the data we hold on you</li>
                  <li>Correct inaccurate data</li>
                  <li>Delete your account and associated data</li>
                  <li>
                    Export your orders and API key metadata as JSON (the Settings → Export button in
                    the dashboard)
                  </li>
                  <li>Object to processing or request restriction</li>
                </ul>
                <p>
                  Email <a href="mailto:privacy@cards402.com">privacy@cards402.com</a> with any of
                  these requests. We respond within 30 days, usually within 48 hours.
                </p>
              </>
            ),
          },
          {
            heading: 'Security',
            body: (
              <>
                <p>
                  API keys are stored as bcrypt hashes with per-key salt — we can verify a key on
                  request but we cannot recover one. The database is encrypted at rest. HTTPS is
                  enforced on every endpoint with a 90-day certificate rotation. More detail on our
                  security posture is on the <Link href="/security">Security</Link> page.
                </p>
              </>
            ),
          },
          {
            heading: 'Changes to this policy',
            body: (
              <>
                <p>
                  Material changes to this policy (new sub-processor, new retention policy, new data
                  category collected) are announced via email to all active account holders at least
                  30 days before they take effect. You can review the history of this page on our{' '}
                  <Link href="/changelog">Changelog</Link>.
                </p>
                <p>
                  Questions about this policy:{' '}
                  <a href="mailto:privacy@cards402.com">privacy@cards402.com</a>
                </p>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
