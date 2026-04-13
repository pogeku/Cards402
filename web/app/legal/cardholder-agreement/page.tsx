import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHero } from '@/app/components/MarketingPage';
import { LegalBody } from '@/app/components/MarketingPage';

export const metadata: Metadata = {
  title: 'Visa Reward Card cardholder agreement',
  description:
    'Summary of the Pathward, N.A. Visa Reward Card cardholder agreement that governs every card issued through Cards402.',
  alternates: { canonical: 'https://cards402.com/legal/cardholder-agreement' },
};

// BreadcrumbList JSON-LD — Legal → Cardholder agreement.
const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Legal',
      item: 'https://cards402.com/terms',
    },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Cardholder agreement',
      item: 'https://cards402.com/legal/cardholder-agreement',
    },
  ],
};

export default function CardholderAgreementPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <PageHero
        eyebrow="Legal · Cardholder agreement"
        title="Your card, your"
        accent="terms"
        intro={
          <>
            Every Cards402 card is a Visa® Reward Card issued by{' '}
            <strong style={{ color: 'var(--fg)' }}>Pathward, N.A., Member FDIC</strong>, pursuant to
            a license from Visa U.S.A. Inc. This page is a plain-English summary of the agreement
            between you and the issuer. In any conflict, the original Pathward agreement governs.
          </>
        }
      />

      <LegalBody
        intro={
          <>
            Effective 1 July 2022. Last synced with the issuer&apos;s published terms on publication
            of this page. The most current source document is hosted at{' '}
            <a href="https://www.yourrewardcard.com" target="_blank" rel="noreferrer noopener">
              YourRewardCard.com
            </a>
            .
          </>
        }
        sections={[
          {
            heading: '1. About your card',
            body: (
              <>
                <p>
                  Your card is a prepaid Visa Reward Card issued by Pathward, N.A. pursuant to a
                  license from Visa U.S.A. Inc. The card is <strong>not a credit card</strong>, not
                  a checking account, and not connected to any account other than the stored-value
                  account where your funds are held.
                </p>
                <p>
                  The funds on your card are <strong>not FDIC-insured to you</strong>. Pathward,
                  N.A. acts as custodian of your funds.
                </p>
                <p>
                  Activation: if the card includes a notice that activation is required, call the
                  number or visit the website shown on the back before use. Otherwise, you can use
                  it immediately.
                </p>
              </>
            ),
          },
          {
            heading: '2. Fees',
            body: (
              <>
                <ul>
                  <li>
                    <strong>Monthly fee:</strong> $2.50 per month, applied to the remaining balance
                    after the 6th month following activation (except where prohibited by law).
                  </li>
                  <li>
                    <strong>Replacement fee:</strong> $5.95 for each replacement card. Replacements
                    sent due to expiration are free.
                  </li>
                  <li>
                    <strong>Foreign transaction fee:</strong> $2.00 + 2% of the transaction amount,
                    charged on purchases in a currency or country other than the card&apos;s.
                  </li>
                  <li>
                    <strong>Cards402 service fee:</strong> $0.00. Cards402 sells the card at face
                    value and does not add a markup or service fee on top of the Pathward fees
                    listed above.
                  </li>
                </ul>
              </>
            ),
          },
          {
            heading: '3. Expiration',
            body: (
              <>
                <p>
                  Your card carries a &ldquo;Valid Thru&rdquo; date on the front. You may not use
                  the card after that date, but <strong>the funds on the card do not expire</strong>
                  . If the card itself has expired, contact customer service to access any remaining
                  balance or to request a replacement (free of charge for expiration-related
                  replacements).
                </p>
              </>
            ),
          },
          {
            heading: '4. Spending and loading limits',
            body: (
              <>
                <ul>
                  <li>
                    <strong>Maximum card balance at any time:</strong> $10,000.
                  </li>
                  <li>
                    <strong>Maximum point-of-sale transaction:</strong> $5,000 signature, $5,000
                    PIN.
                  </li>
                  <li>
                    <strong>Maximum per day:</strong> $5,000.
                  </li>
                  <li>
                    <strong>Cash access:</strong> None. You cannot use the card at an ATM or to
                    obtain cash as part of a purchase.
                  </li>
                  <li>
                    <strong>Recurring payments:</strong> Not permitted. The card cannot be used for
                    subscriptions, memberships, rentals, or similar recurring charges.
                  </li>
                </ul>
                <p>
                  Third parties (individual merchants, gateways) may impose additional limitations
                  on top of these.
                </p>
              </>
            ),
          },
          {
            heading: '5. International use',
            body: (
              <>
                <p>
                  If you make a purchase in a currency or country other than the one your card was
                  issued in (a &ldquo;Foreign Transaction&rdquo;), the amount deducted will be
                  converted by the Visa network into the card currency. The conversion rate is
                  either selected from the range available in wholesale currency markets or is the
                  government-mandated rate for the applicable processing date.
                </p>
                <p>
                  The $2.00 + 2% Foreign Transaction Fee applies in addition to the converted
                  purchase amount. If a foreign transaction is refunded, the original foreign
                  transaction fee is not refunded.
                </p>
              </>
            ),
          },
          {
            heading: '6. Using your card',
            body: (
              <>
                <p>
                  You agree not to spend more than the available balance. If a transaction somehow
                  exceeds the balance (for example, via a systems malfunction), you remain liable
                  for the excess.
                </p>
                <p>
                  If you allow another person to use your card, you are responsible under this
                  agreement for all transactions, fees, and charges they make, even if you did not
                  intend to authorise them.
                </p>
                <p>
                  You will not receive a pre-set PIN. At your first PIN-based transaction, any
                  4-digit code you enter becomes the PIN for subsequent PIN-based transactions. You
                  may reset the PIN via the issuer&apos;s website or customer service.
                </p>
              </>
            ),
          },
          {
            heading: '7. Unauthorised transactions',
            body: (
              <>
                <p>
                  If you believe your card has been lost, stolen, or used without your permission,
                  contact Pathward customer service <strong>immediately</strong> at 1-833-634-3155
                  (or via{' '}
                  <a
                    href="https://www.yourrewardcard.com"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    YourRewardCard.com
                  </a>
                  ). You may be unable to receive assistance if you do not contact the issuer within
                  60 days of the unauthorised transaction. The issuer&apos;s standard lost/stolen
                  card fee applies and is deducted from the balance on the card.
                </p>
              </>
            ),
          },
          {
            heading: '8. Disputes and arbitration',
            body: (
              <>
                <p>
                  The cardholder agreement contains an <strong>arbitration clause</strong> requiring
                  all claims to be resolved by binding arbitration, plus a jury trial waiver to the
                  extent permitted by law. You may opt out of the arbitration clause within 60
                  calendar days of the earlier of purchasing, activating, or using the card by
                  sending written notice to:
                </p>
                <p>
                  <strong>Pathward, N.A.</strong>
                  <br />
                  Attn: Customer Service
                  <br />
                  5501 S Broadband Ln
                  <br />
                  Sioux Falls, SD 57108
                </p>
                <p>
                  The cardholder agreement is governed by the law of the State of South Dakota
                  except to the extent federal law applies.
                </p>
              </>
            ),
          },
          {
            heading: '9. Customer service',
            body: (
              <>
                <ul>
                  <li>
                    <strong>Phone:</strong> 1-833-634-3155
                  </li>
                  <li>
                    <strong>Website:</strong>{' '}
                    <a
                      href="https://www.yourrewardcard.com"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      YourRewardCard.com
                    </a>
                  </li>
                  <li>
                    <strong>Mail:</strong> P.O. Box 826, Fortson, GA 31808
                  </li>
                </ul>
                <p>
                  For Cards402-specific questions (API issues, order status, failed fulfilment),
                  contact <a href="mailto:support@cards402.com">support@cards402.com</a> directly —
                  we&apos;ll triage anything that needs to escalate to the issuer on your behalf.
                </p>
              </>
            ),
          },
          {
            heading: 'Disclaimer',
            body: (
              <>
                <p>
                  This page is a plain-English summary provided for convenience. It is not legal
                  advice and it is not the contract. The binding contract between you and the card
                  issuer is the Pathward Visa Reward Card cardholder agreement published at{' '}
                  <a
                    href="https://www.yourrewardcard.com"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    YourRewardCard.com
                  </a>
                  . In any conflict between this summary and the Pathward agreement, the Pathward
                  agreement governs.
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--fg-dim)' }}>
                  Prepaid card is issued by Pathward, N.A., Member FDIC, pursuant to a license from
                  Visa U.S.A. Inc.
                  <br />© 2022 Pathward, N.A. · C1949_600_072122
                </p>
                <p>
                  <Link href="/terms" className="link-subtle">
                    Cards402 Terms of Service →
                  </Link>
                </p>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
