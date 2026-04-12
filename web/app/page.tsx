import Link from 'next/link';

const createOrderRequest = `POST https://api.cards402.com/v1/orders
X-Api-Key: cards402_your_key_here
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "amount_usdc": "25.00",
  "payment_asset": "usdc"
}`;

const createOrderResponse = `HTTP/1.1 201 Created

{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d",
  "status": "pending_payment",
  "payment": {
    "type": "soroban_contract",
    "contract_id": "C...cards402_receiver...",
    "order_id": "a3f7c2d1-4e8b-4f0a-9c2d",
    "usdc": { "amount": "25.00", "asset": "USDC:GA5Z..." },
    "xlm":  { "amount": "178.57" }
  },
  "poll_url": "/v1/orders/a3f7c2d1-4e8b-4f0a-9c2d"
}`;

const pollDelivered = `GET https://api.cards402.com/v1/orders/a3f7c2d1-...
X-Api-Key: cards402_your_key_here

HTTP/1.1 200 OK

{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d",
  "phase": "ready",
  "amount_usdc": "25.00",
  "card": {
    "number": "4111 1111 1111 1111",
    "cvv": "847",
    "expiry": "12/27",
    "brand": "Visa"
  }
}`;

const steps = [
  {
    num: '01',
    title: 'Create order',
    body: 'POST /v1/orders with your card value in USDC. Get back a Soroban receiver-contract ID and the order_id to pass to it.',
  },
  {
    num: '02',
    title: 'Call the contract',
    body: 'Invoke pay_usdc (or pay_xlm) on the receiver contract with your wallet. The SDK builds, signs, and submits the Soroban transaction for you.',
  },
  {
    num: '03',
    title: 'Get card details',
    body: 'Poll GET /v1/orders/:id or receive a webhook. When phase is "ready", the response includes PAN, CVV, and expiry.',
  },
];

const specs = [
  { label: 'Network', value: 'Stellar (Horizon)' },
  { label: 'Payment assets', value: 'USDC (Circle) · XLM' },
  { label: 'Card network', value: 'Visa prepaid virtual' },
  { label: 'Rate', value: '1 USDC = $1.00 card value' },
  { label: 'Fulfillment time', value: '~60 seconds typical' },
  { label: 'Auth', value: 'X-Api-Key header' },
  { label: 'KYC required', value: 'None' },
  { label: 'Fees', value: 'None' },
];

export default function Home() {
  return (
    <div style={{ background: 'var(--bg)', color: 'var(--fg)' }}>

      {/* ── Hero ─────────────────────────────────────────── */}
      <section
        className="dot-grid"
        style={{
          minHeight: 'min(88vh, 680px)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
          padding: '6rem 1.5rem 4rem',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Radial green glow */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '35%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 700,
            height: 350,
            background:
              'radial-gradient(ellipse at center, rgba(0,255,136,0.07) 0%, transparent 68%)',
            pointerEvents: 'none',
          }}
        />

        {/* Badge */}
        <div
          className="animate-fade-in"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            border: '1px solid var(--green-border)',
            background: 'var(--green-muted)',
            borderRadius: 999,
            padding: '0.3125rem 1rem',
            fontSize: '0.7rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--green)',
            fontWeight: 600,
            letterSpacing: '0.06em',
            marginBottom: '2rem',
            textTransform: 'uppercase',
          }}
        >
          <span
            className="pulse-green"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--green)',
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          Stellar · USDC · XLM · Visa
        </div>

        {/* Headline */}
        <h1
          className="animate-fade-in"
          style={{
            fontSize: 'clamp(2.25rem, 6vw, 4rem)',
            fontWeight: 800,
            lineHeight: 1.08,
            letterSpacing: '-0.03em',
            maxWidth: 700,
            marginBottom: '1.25rem',
            animationDelay: '0.05s',
            animationFillMode: 'both',
          }}
        >
          Virtual cards for
          <br />
          <span style={{ color: 'var(--green)' }} className="glow-green">
            AI agents
          </span>
          , instantly.
        </h1>

        {/* Sub-headline */}
        <p
          className="animate-fade-in"
          style={{
            fontSize: 'clamp(1rem, 2.5vw, 1.1875rem)',
            color: 'var(--muted)',
            maxWidth: 480,
            lineHeight: 1.65,
            marginBottom: '2.5rem',
            animationDelay: '0.1s',
            animationFillMode: 'both',
          }}
        >
          Pay USDC or XLM on Stellar.
          <br />
          Get a Visa card number in ~60 seconds.
        </p>

        {/* Pill badges */}
        <div
          className="animate-fade-in"
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            justifyContent: 'center',
            marginBottom: '2.75rem',
            animationDelay: '0.15s',
            animationFillMode: 'both',
          }}
        >
          {['No signup', 'No KYC', 'No fees', '1:1 card value'].map((pill) => (
            <span
              key={pill}
              style={{
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                borderRadius: 999,
                padding: '0.3rem 0.875rem',
                fontSize: '0.8125rem',
                color: 'var(--muted)',
              }}
            >
              {pill}
            </span>
          ))}
        </div>

        {/* CTA buttons */}
        <div
          className="animate-fade-in"
          style={{
            display: 'flex',
            gap: '0.75rem',
            flexWrap: 'wrap',
            justifyContent: 'center',
            animationDelay: '0.2s',
            animationFillMode: 'both',
          }}
        >
          <Link
            href="/docs"
            style={{
              background: 'var(--green)',
              color: '#000',
              padding: '0.6875rem 1.5rem',
              borderRadius: 8,
              fontWeight: 700,
              fontSize: '0.9375rem',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
            }}
          >
            Read the docs
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M3 8h10M9 4l4 4-4 4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <Link
            href="/dashboard"
            style={{
              background: 'transparent',
              color: 'var(--fg)',
              padding: '0.6875rem 1.5rem',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: '0.9375rem',
              textDecoration: 'none',
              border: '1px solid var(--border)',
            }}
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────── */}
      <section style={{ maxWidth: 1100, margin: '0 auto', padding: '5rem 1.5rem' }}>
        <div style={{ marginBottom: '2.75rem' }}>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              color: 'var(--green)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: '0.625rem',
              fontWeight: 600,
            }}
          >
            How it works
          </p>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              fontWeight: 700,
              letterSpacing: '-0.02em',
            }}
          >
            Three steps from wallet to card
          </h2>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          {steps.map((step) => (
            <div
              key={step.num}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '1.75rem',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  top: '-0.5rem',
                  right: '1rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '5rem',
                  fontWeight: 900,
                  color: 'rgba(255,255,255,0.03)',
                  lineHeight: 1,
                  userSelect: 'none',
                  pointerEvents: 'none',
                }}
              >
                {step.num}
              </span>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.68rem',
                  color: 'var(--green)',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  marginBottom: '0.75rem',
                }}
              >
                Step {step.num}
              </div>
              <h3
                style={{
                  fontSize: '1.0625rem',
                  fontWeight: 700,
                  marginBottom: '0.625rem',
                  letterSpacing: '-0.01em',
                }}
              >
                {step.title}
              </h3>
              <p style={{ color: 'var(--muted)', fontSize: '0.875rem', lineHeight: 1.65, margin: 0 }}>
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── API code examples ─────────────────────────────── */}
      <section
        style={{
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '5rem 1.5rem' }}>
          <div style={{ marginBottom: '2.75rem' }}>
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.7rem',
                color: 'var(--green)',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                marginBottom: '0.625rem',
                fontWeight: 600,
              }}
            >
              API
            </p>
            <h2
              style={{
                fontSize: 'clamp(1.5rem, 3vw, 2rem)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                marginBottom: '0.625rem',
              }}
            >
              Designed for agents
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: '0.9375rem', lineHeight: 1.6, margin: 0 }}>
              Two endpoints. POST to create, GET to poll. Webhook optional.
            </p>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: '1rem',
            }}
          >
            {[
              { label: 'POST /v1/orders — request', code: createOrderRequest },
              { label: 'POST /v1/orders — response', code: createOrderResponse },
              { label: 'GET /v1/orders/:id — delivered', code: pollDelivered },
            ].map(({ label, code }) => (
              <div key={label}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.68rem',
                    color: 'var(--muted)',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    marginBottom: '0.5rem',
                    fontWeight: 600,
                  }}
                >
                  {label}
                </div>
                <pre style={{ fontSize: '0.775rem', lineHeight: 1.7, margin: 0 }}>
                  <code>{code}</code>
                </pre>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '2.25rem' }}>
            <Link
              href="/docs"
              style={{
                color: 'var(--green)',
                fontSize: '0.9375rem',
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
              }}
            >
              Full API reference
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M3 8h10M9 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* ── Specs ─────────────────────────────────────────── */}
      <section style={{ maxWidth: 1100, margin: '0 auto', padding: '5rem 1.5rem' }}>
        <div style={{ marginBottom: '2.75rem' }}>
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              color: 'var(--green)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: '0.625rem',
              fontWeight: 600,
            }}
          >
            Specifications
          </p>
          <h2
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2rem)',
              fontWeight: 700,
              letterSpacing: '-0.02em',
            }}
          >
            The details
          </h2>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '0.625rem',
          }}
        >
          {specs.map((spec) => (
            <div
              key={spec.label}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '1rem 1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.25rem',
              }}
            >
              <span
                style={{
                  fontSize: '0.68rem',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--muted)',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                {spec.label}
              </span>
              <span style={{ fontSize: '0.9375rem', fontWeight: 500 }}>{spec.value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────── */}
      <section
        style={{
          borderTop: '1px solid var(--border)',
          padding: '5rem 1.5rem',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 600,
            height: 250,
            background:
              'radial-gradient(ellipse at bottom, rgba(0,255,136,0.06) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            color: 'var(--green)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginBottom: '1rem',
            fontWeight: 600,
          }}
        >
          Get started
        </p>
        <h2
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
            fontWeight: 800,
            letterSpacing: '-0.03em',
            marginBottom: '1.125rem',
          }}
        >
          Ready to integrate?
        </h2>
        <p
          style={{
            color: 'var(--muted)',
            maxWidth: 420,
            margin: '0 auto 2.5rem',
            lineHeight: 1.65,
            fontSize: '0.9375rem',
          }}
        >
          Sign up, create an API key, and your agent can be buying cards in minutes.
        </p>
        <div
          style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}
        >
          <Link
            href="/dashboard"
            style={{
              background: 'var(--green)',
              color: '#000',
              padding: '0.75rem 2rem',
              borderRadius: 8,
              fontWeight: 700,
              fontSize: '0.9375rem',
              textDecoration: 'none',
            }}
          >
            Get started
          </Link>
          <Link
            href="/docs"
            style={{
              background: 'transparent',
              color: 'var(--fg)',
              padding: '0.75rem 2rem',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: '0.9375rem',
              textDecoration: 'none',
              border: '1px solid var(--border)',
            }}
          >
            Read the docs
          </Link>
        </div>
        <div style={{ marginTop: '2rem', display: 'flex', gap: '1.25rem', justifyContent: 'center' }}>
          <Link
            href="/agents.txt"
            style={{
              color: 'var(--muted)',
              fontSize: '0.8125rem',
              textDecoration: 'none',
              fontFamily: 'var(--font-mono)',
            }}
          >
            /agents.txt
          </Link>
          <a
            href="mailto:api@cards402.com"
            style={{
              color: 'var(--muted)',
              fontSize: '0.8125rem',
              textDecoration: 'none',
              fontFamily: 'var(--font-mono)',
            }}
          >
            api@cards402.com
          </a>
        </div>
      </section>
    </div>
  );
}
