import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero, LegalBody } from '@/app/components/MarketingPage';

export const metadata: Metadata = {
  title: 'Terms of service',
  description:
    'The terms under which Cards402 provides the agent card-issuance API. Plain English, no dark patterns.',
  alternates: { canonical: 'https://cards402.com/terms' },
};

export default function TermsPage() {
  return (
    <>
      <PageHero
        eyebrow="Legal · Terms of service"
        title="The deal, in plain"
        accent="English"
        intro="Cards402 is a developer tool. These terms describe what we provide, what we expect from you in return, and how the relationship can end. They are boring, deliberately."
      />

      <LegalBody
        intro={
          <>
            <strong>Last updated 14 April 2026.</strong> By using Cards402 you agree to these terms.
            If anything here is unclear, email{' '}
            <a href="mailto:legal@cards402.com">legal@cards402.com</a> and we&apos;ll clarify — both
            in email and on this page.
          </>
        }
        sections={[
          {
            heading: '1. What Cards402 provides',
            body: (
              <>
                <p>
                  Cards402 provides an HTTP + SDK interface that lets you create a Visa prepaid
                  reward card order, settle it on the Stellar network in USDC or XLM, and receive
                  the card details programmatically. The cards themselves are issued by{' '}
                  <strong>Pathward, N.A.</strong> (the &ldquo;Issuer&rdquo;) and are governed by the{' '}
                  <Link href="/legal/cardholder-agreement">
                    Pathward Visa Reward Card cardholder agreement
                  </Link>
                  , which takes precedence over these terms for anything related to the card itself
                  (limits, fees, disputes, chargebacks).
                </p>
                <p>
                  Cards402 is <strong>not</strong> a bank, not a money services business, and not a
                  payment processor in the regulatory sense. We are a software interface on top of
                  an existing, regulated card issuance programme.
                </p>
              </>
            ),
          },
          {
            heading: '2. Who can use the service',
            body: (
              <>
                <p>
                  You must not be located in a country subject to OFAC, UK, or EU comprehensive
                  sanctions. You must not use Cards402 to issue cards to any sanctioned person or
                  entity.
                </p>
                <p>
                  If you&apos;re using Cards402 on behalf of a company, you warrant that you have
                  the authority to bind that company to these terms.
                </p>
              </>
            ),
          },
          {
            heading: '3. Acceptable use',
            body: (
              <>
                <p>You agree not to use Cards402 to:</p>
                <ul>
                  <li>Finance illegal activity under any applicable jurisdiction;</li>
                  <li>Launder funds, evade sanctions, or circumvent know-your-customer rules;</li>
                  <li>
                    Issue cards to shell accounts with the intent to obscure the beneficial owner;
                  </li>
                  <li>
                    Operate agents that use cards against merchants in violation of the
                    merchants&apos; terms of service;
                  </li>
                  <li>
                    Attempt to exceed the per-transaction or daily spend limits imposed by the
                    Issuer;
                  </li>
                  <li>Resell the service as a white-label product without written permission.</li>
                </ul>
                <p>
                  We reserve the right to suspend or terminate access for any breach of this
                  section, or where we have a reasonable belief that a breach is occurring.
                  Suspension is immediate; termination is final.
                </p>
              </>
            ),
          },
          {
            heading: '4. API keys and agent credentials',
            body: (
              <>
                <p>
                  You are responsible for all activity that occurs under any API key issued to your
                  account. Keys are bearer tokens — if one leaks, anyone holding it can spend
                  against your account up to the key&apos;s spend limit until you revoke it.
                </p>
                <p>
                  We strongly recommend using claim codes (single-use onboarding tokens) instead of
                  pasting raw API keys into agent context, especially when working with LLM-backed
                  agents. Cards402 provides the claim-code flow specifically for this reason.
                </p>
              </>
            ),
          },
          {
            heading: '5. Payment and refunds',
            body: (
              <>
                <p>
                  Cards402 sells cards at face value — you pay exactly the stated USD amount in USDC
                  or the quoted XLM equivalent. No service fee, no markup, no hidden spread. See the{' '}
                  <Link href="/pricing">Pricing</Link> page for details.
                </p>
                <p>
                  If an order fails before the card is issued (for example, because the fulfilment
                  pipeline errored), the full USDC or XLM payment is automatically refunded to the
                  sender address within 24 hours. Refund transactions are on-chain and the
                  transaction ID is available in the order record.
                </p>
                <p>
                  Once a card is issued, the funds are loaded on the card and are not refundable by
                  Cards402. The card can still be spent, and the cardholder (you or your agent) owns
                  the balance subject to the issuer&apos;s terms.
                </p>
                <p>
                  <strong>Overpayments</strong> (sending more than the quoted amount) and{' '}
                  <strong>underpayments</strong> (sending less) are not automatically reconciled.
                  Overpayments go to an unmatched payments queue; underpayments expire the order. In
                  either case, contact support to recover the funds — this is manual.
                </p>
              </>
            ),
          },
          {
            heading: '6. Service availability',
            body: (
              <>
                <p>
                  Cards402 aims for 99.9% monthly uptime on the HTTP API. We publish status and
                  incident postmortems at{' '}
                  <a href="https://status.cards402.com">status.cards402.com</a>. Scheduled
                  maintenance windows are announced at least 48 hours in advance on the same page.
                </p>
                <p>
                  The Issuer&apos;s upstream systems are outside our direct control. If Pathward
                  experiences an outage, Cards402 order fulfilment may stall until upstream
                  recovers. We will not charge you for orders that cannot complete due to upstream
                  outage — the payment is refunded automatically.
                </p>
              </>
            ),
          },
          {
            heading: '7. Disclaimers',
            body: (
              <>
                <p>
                  The service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the
                  maximum extent permitted by law, Cards402 disclaims all warranties, express or
                  implied, including merchantability, fitness for a particular purpose, and
                  non-infringement.
                </p>
                <p>
                  Cards402 is not responsible for the behaviour of any agent or program you build on
                  top of the service. If your agent spends $500 on cat food because you told it to
                  buy cat food and your supplier only stocks tuna, that is not our problem.
                </p>
              </>
            ),
          },
          {
            heading: '8. Limitation of liability',
            body: (
              <>
                <p>
                  To the maximum extent permitted by law, Cards402&apos;s total liability for any
                  claim arising out of or relating to the service is limited to the fees paid by you
                  to Cards402 in the twelve months preceding the claim.
                </p>
                <p>
                  We are not liable for indirect, incidental, consequential, special, or punitive
                  damages, even if advised of the possibility of such damages. We are also not
                  liable for any loss of data, revenue, profit, or reputation.
                </p>
              </>
            ),
          },
          {
            heading: '9. Termination',
            body: (
              <>
                <p>
                  You can terminate your account at any time from the dashboard settings. On
                  termination, all API keys are revoked immediately, and account data is retained or
                  deleted per the <Link href="/privacy">Privacy policy</Link>.
                </p>
                <p>
                  We can terminate your account if you breach these terms, if legal process requires
                  it, or if we exit the business. In the last case, we will give you at least 60
                  days&apos; notice and refund any unspent balance.
                </p>
              </>
            ),
          },
          {
            heading: '10. Governing law',
            body: (
              <>
                <p>
                  These terms are governed by the laws of England and Wales, without regard to
                  conflict-of-law principles. Disputes will be resolved in the courts of England and
                  Wales, except where local consumer protection law requires otherwise.
                </p>
                <p>
                  Note that disputes about the card itself (balance, fees, unauthorised
                  transactions) are governed by the Pathward cardholder agreement, which specifies
                  South Dakota law and includes an arbitration clause.
                </p>
              </>
            ),
          },
          {
            heading: '11. Changes to these terms',
            body: (
              <>
                <p>
                  We may update these terms. Material changes (anything affecting acceptable use,
                  pricing, liability, or termination) are announced at least 30 days before they
                  take effect via email and the <Link href="/changelog">Changelog</Link>.
                </p>
                <p>
                  If you don&apos;t agree to a change, you can terminate your account before the
                  change takes effect. Continued use after the effective date means you accept the
                  updated terms.
                </p>
              </>
            ),
          },
          {
            heading: 'Contact',
            body: (
              <>
                <p>
                  Legal questions: <a href="mailto:legal@cards402.com">legal@cards402.com</a>.
                </p>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
