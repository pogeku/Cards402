import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'API Reference — cards402',
  description: 'Full API reference for cards402: create orders, poll status, handle webhooks.',
};

function Code({ children }: { children: string }) {
  return (
    <code
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8125em',
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '0.15em 0.4em',
        color: 'var(--green)',
      }}
    >
      {children}
    </code>
  );
}

function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 80, marginBottom: '4rem' }}>
      {children}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: '1.25rem',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        marginBottom: '1.25rem',
        paddingBottom: '0.75rem',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {children}
    </h2>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: '0.9375rem',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        marginBottom: '0.75rem',
        marginTop: '1.75rem',
        color: 'var(--fg)',
      }}
    >
      {children}
    </h3>
  );
}

function Para({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p
      style={{
        color: 'var(--muted)',
        fontSize: '0.9rem',
        lineHeight: 1.7,
        marginBottom: '1rem',
        margin: '0 0 1rem',
        ...style,
      }}
    >
      {children}
    </p>
  );
}

function CodeBlock({ label, children }: { label?: string; children: string }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      {label && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.68rem',
            color: 'var(--muted)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fontWeight: 600,
            marginBottom: '0.4rem',
          }}
        >
          {label}
        </div>
      )}
      <pre style={{ margin: 0, fontSize: '0.8125rem', lineHeight: 1.7 }}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

const navItems = [
  { href: '#authentication', label: 'Authentication' },
  { href: '#create-order', label: 'Create order' },
  { href: '#stream-order', label: 'Stream order (SSE)' },
  { href: '#poll-order', label: 'Poll order (fallback)' },
  { href: '#order-statuses', label: 'Order statuses' },
  { href: '#webhooks', label: 'Webhooks' },
  { href: '#errors', label: 'Error codes' },
  { href: '#rate-limits', label: 'Rate limits' },
];

// Stable agent-facing phases (internal pipeline statuses are implementation detail)
const orderStatuses = [
  {
    status: 'awaiting_payment',
    meaning: 'Order created, waiting for your Stellar payment to confirm on-chain.',
  },
  {
    status: 'processing',
    meaning: 'Payment confirmed. Card is being fulfilled — typically 30–90 seconds.',
  },
  {
    status: 'ready',
    meaning: 'Card details are ready. Poll response includes the card object.',
  },
  {
    status: 'failed',
    meaning:
      'Fulfillment failed. The error field contains the reason. A refund is automatically queued.',
  },
  {
    status: 'refunded',
    meaning:
      'Payment refunded to your sender address. The refund_stellar_txid field has the transaction hash.',
  },
  {
    status: 'expired',
    meaning: 'No payment arrived within 2 hours. No funds were taken. Create a new order to retry.',
  },
];

const errors = [
  { code: 'missing_api_key', status: 401, meaning: 'X-Api-Key header not provided.' },
  { code: 'invalid_api_key', status: 401, meaning: 'API key not found or disabled.' },
  {
    code: 'invalid_amount',
    status: 400,
    meaning: 'amount_usdc is missing or not a positive number.',
  },
  { code: 'invalid_payment_asset', status: 400, meaning: 'payment_asset must be "usdc" or "xlm".' },
  {
    code: 'spend_limit_exceeded',
    status: 403,
    meaning: 'This key has reached its USDC spend limit.',
  },
  {
    code: 'order_not_found',
    status: 404,
    meaning: 'Order does not exist or belongs to another key.',
  },
  {
    code: 'xlm_price_unavailable',
    status: 503,
    meaning: 'XLM price feed unavailable. Retry in a few seconds or use USDC instead.',
  },
  {
    code: 'service_temporarily_unavailable',
    status: 503,
    meaning: 'Circuit breaker tripped after repeated failures. Try again later.',
  },
];

export default function DocsPage() {
  return (
    <div
      style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
        display: 'flex',
        minHeight: '100%',
      }}
    >
      {/* Sidebar */}
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: '1px solid var(--border)',
          position: 'sticky',
          top: 56,
          height: 'calc(100vh - 56px)',
          overflowY: 'auto',
          padding: '2rem 0',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="docs-sidebar"
      >
        <div style={{ padding: '0 1.25rem', marginBottom: '0.75rem' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              color: 'var(--muted)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            API Reference
          </span>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              style={{
                padding: '0.4375rem 1.25rem',
                fontSize: '0.875rem',
                color: 'var(--muted)',
                textDecoration: 'none',
                borderRadius: 0,
                transition: 'color 0.12s',
                display: 'block',
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div
          style={{
            marginTop: 'auto',
            padding: '1.5rem 1.25rem 0',
            borderTop: '1px solid var(--border)',
            marginRight: 0,
          }}
        >
          <a
            href="mailto:api@cards402.com"
            style={{
              fontSize: '0.8125rem',
              color: 'var(--muted)',
              textDecoration: 'none',
              fontFamily: 'var(--font-mono)',
            }}
          >
            api@cards402.com
          </a>
        </div>
      </aside>

      {/* Main content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: '3rem 2.5rem 6rem',
          maxWidth: 780,
        }}
      >
        {/* Page header */}
        <div style={{ marginBottom: '3rem' }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              color: 'var(--green)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: '0.625rem',
            }}
          >
            cards402.com
          </div>
          <h1
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2.25rem)',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              marginBottom: '0.75rem',
            }}
          >
            API Reference
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: '1rem', lineHeight: 1.65, margin: 0 }}>
            Base URL: <Code>https://api.cards402.com</Code>
            <br />
            All requests require an <Code>X-Api-Key</Code> header. Sign in at{' '}
            <Link href="/dashboard" style={{ color: 'var(--green)', textDecoration: 'none' }}>
              /dashboard
            </Link>{' '}
            with your email to create one in seconds — no manual onboarding.
          </p>
        </div>

        {/* ── Authentication ── */}
        <Section id="authentication">
          <SectionTitle>Authentication</SectionTitle>
          <Para>
            Every request must include an <Code>X-Api-Key</Code> header. Keys are prefixed with{' '}
            <Code>cards402_</Code> and scoped to a spend limit in USDC.
          </Para>
          <Para>
            Create a key: sign in at{' '}
            <Link href="/dashboard" style={{ color: 'var(--green)', textDecoration: 'none' }}>
              /dashboard
            </Link>{' '}
            with any email (you&apos;ll get a 6-digit login code), open the <strong>Keys</strong>{' '}
            tab, and click <strong>New key</strong>. The raw token is shown once in a copy modal,
            then stored as a salted hash — keep it in your password manager.
          </Para>
          <CodeBlock label="Header">{`X-Api-Key: cards402_a1b2c3d4e5f6...`}</CodeBlock>
          <Para>
            If the key is missing, invalid, or disabled, the API returns{' '}
            <Code>401 Unauthorized</Code>. If the key has a spend limit and it is exceeded, the API
            returns <Code>403 Forbidden</Code>.
          </Para>
        </Section>

        {/* ── Create order ── */}
        <Section id="create-order">
          <SectionTitle>Create order</SectionTitle>
          <Para>
            Creates a new card order and returns Stellar payment instructions. The agent must send
            the exact amount to the Stellar address within the quoted window.
          </Para>

          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '0.875rem 1.125rem',
              marginBottom: '1.25rem',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
            }}
          >
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>POST</span>
            <span style={{ color: 'var(--muted)', marginLeft: '0.75rem' }}>/orders</span>
          </div>

          <SubTitle>Request body</SubTitle>
          <Para>
            Content-Type: <Code>application/json</Code>
          </Para>

          <div style={{ marginBottom: '1.5rem', overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <Code>amount_usdc</Code>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>string</td>
                  <td style={{ color: 'var(--muted)' }}>Yes</td>
                  <td style={{ color: 'var(--muted)' }}>
                    Card value in USD, as a decimal string (e.g. <Code>&quot;25.00&quot;</Code>).
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>payment_asset</Code>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>string</td>
                  <td style={{ color: 'var(--muted)' }}>No</td>
                  <td style={{ color: 'var(--muted)' }}>
                    <Code>&quot;usdc&quot;</Code> (default) or <Code>&quot;xlm&quot;</Code>.
                    Determines the payment asset and returned quote.
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>webhook_url</Code>
                  </td>
                  <td style={{ color: 'var(--muted)' }}>string</td>
                  <td style={{ color: 'var(--muted)' }}>No</td>
                  <td style={{ color: 'var(--muted)' }}>
                    HTTPS URL to receive webhook POSTs on status changes.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <SubTitle>Example — USDC payment</SubTitle>
          <CodeBlock label="Request">
            {`POST /orders
X-Api-Key: cards402_your_key_here
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "amount_usdc": "25.00",
  "payment_asset": "usdc",
  "webhook_url": "https://your-agent.com/webhook"
}`}
          </CodeBlock>
          <CodeBlock label="Response — 201 Created">
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "pending_payment",
  "payment": {
    "type": "soroban_contract",
    "contract_id": "CAAAA...cards402_receiver_contract...",
    "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
    "usdc": {
      "amount": "25.00",
      "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    },
    "xlm": { "amount": "192.84" }
  },
  "poll_url": "/v1/orders/a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "budget": {
    "spent_usdc": "15.00",
    "limit_usdc": "100.00",
    "remaining_usdc": "85.00"
  }
}`}
          </CodeBlock>

          <SubTitle>Example — XLM payment</SubTitle>
          <Para>
            When <Code>payment_asset</Code> is <Code>&quot;xlm&quot;</Code>, the XLM amount is
            quoted at the current market rate. The SDK calls <Code>pay_xlm()</Code> on the Soroban
            contract with this exact amount — no memo or address handling required.
          </Para>
          <CodeBlock label="Request">
            {`POST /orders
X-Api-Key: cards402_your_key_here
Content-Type: application/json

{
  "amount_usdc": "25.00",
  "payment_asset": "xlm"
}`}
          </CodeBlock>
          <CodeBlock label="Response — 201 Created">
            {`{
  "order_id": "b9e1f3a2-7c4d-4b0e-8f1a-2c4e6a8b0d2f",
  "status": "pending_payment",
  "payment": {
    "type": "soroban_contract",
    "contract_id": "CAAAA...cards402_receiver_contract...",
    "order_id": "b9e1f3a2-7c4d-4b0e-8f1a-2c4e6a8b0d2f",
    "usdc": {
      "amount": "25.00",
      "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    },
    "xlm": { "amount": "192.84" }
  },
  "poll_url": "/v1/orders/b9e1f3a2-7c4d-4b0e-8f1a-2c4e6a8b0d2f",
  "budget": {
    "spent_usdc": "0.00",
    "limit_usdc": null,
    "remaining_usdc": null
  }
}`}
          </CodeBlock>

          <SubTitle>USDC vs XLM — which to use?</SubTitle>
          <div style={{ marginBottom: '1.25rem', overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>USDC</th>
                  <th>XLM</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>Card value</td>
                  <td style={{ color: 'var(--muted)' }}>Exact — 1 USDC = $1.00</td>
                  <td style={{ color: 'var(--muted)' }}>Market rate, quoted at order time</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>Setup</td>
                  <td style={{ color: 'var(--muted)' }}>Requires USDC trustline</td>
                  <td style={{ color: 'var(--muted)' }}>No trustline needed</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>Wallet needs</td>
                  <td style={{ color: 'var(--muted)' }}>XLM (fees) + USDC balance</td>
                  <td style={{ color: 'var(--muted)' }}>XLM balance only</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>Predictability</td>
                  <td style={{ color: 'var(--muted)' }}>High — no price risk</td>
                  <td style={{ color: 'var(--muted)' }}>Varies with XLM/USD rate</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Para>
            The SDK handles both automatically. If using the MCP <Code>setup_wallet</Code> tool, the
            USDC trustline is added once the wallet has at least 2 XLM.
          </Para>

          <SubTitle>Payment window</SubTitle>
          <Para>
            Orders in <Code>pending_payment</Code> expire after <strong>2 hours</strong> if no
            on-chain payment is detected. Expired orders return{' '}
            <Code>phase: &quot;expired&quot;</Code>
            and no funds are taken. Create a new order to retry.
          </Para>

          <SubTitle>Overpayment</SubTitle>
          <Para>
            Send exactly the quoted amount. If you send more than the quoted amount, the excess is
            retained and will not be refunded. Underpayments are not matched — the order will expire
            after 2 hours and no card will be issued.
          </Para>

          <div
            style={{
              background: 'var(--green-muted)',
              border: '1px solid var(--green-border)',
              borderRadius: 8,
              padding: '0.875rem 1.125rem',
              fontSize: '0.875rem',
              lineHeight: 1.65,
              color: 'var(--fg)',
            }}
          >
            <strong style={{ color: 'var(--green)' }}>Using the SDK?</strong> Call{' '}
            <Code>purchaseCardOWS()</Code> — it creates the order, signs and submits the Soroban
            transaction, and polls for the card in a single call. No contract interaction or order
            ID handling required.
          </div>
        </Section>

        {/* ── Poll order ── */}
        <Section id="stream-order">
          <SectionTitle>Stream order (SSE) — preferred</SectionTitle>
          <Para>
            Subscribe to live phase updates over Server-Sent Events. One open connection, pushed to
            on every transition, closed cleanly when the order reaches a terminal phase. Prefer this
            over polling for anything that runs as a long-lived process.
          </Para>

          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '0.875rem 1.125rem',
              marginBottom: '1.25rem',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
            }}
          >
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>GET</span>
            <span style={{ color: 'var(--muted)', marginLeft: '0.75rem' }}>/orders/:id/stream</span>
          </div>

          <Para>
            Each event carries the full order state (same JSON shape as <Code>GET /orders/:id</Code>
            ) as its <Code>data:</Code> payload, so a client that reconnects always sees the latest
            phase on the first message — no <Code>Last-Event-ID</Code> handling required.
          </Para>

          <CodeBlock label="Stream">
            {`: connected

id: 1776023489012
event: phase
data: {"order_id":"a3f7c2d1-...","status":"pending_payment","phase":"awaiting_payment","amount_usdc":"25.00","updated_at":"2026-04-08T12:00:00Z"}

id: 1776023510234
event: phase
data: {"order_id":"a3f7c2d1-...","status":"ordering","phase":"processing","updated_at":"2026-04-08T12:00:21Z"}

id: 1776023534567
event: phase
data: {"order_id":"a3f7c2d1-...","status":"delivered","phase":"ready","amount_usdc":"25.00","card":{"number":"4111 2345 6789 0123","cvv":"847","expiry":"12/27","brand":"Visa"},"updated_at":"2026-04-08T12:00:45Z"}`}
          </CodeBlock>

          <CodeBlock label="Minimal client (Node 18+ / browser)">
            {`const res = await fetch(\`\${apiUrl}/orders/\${orderId}/stream\`, {
  headers: { 'X-Api-Key': key, Accept: 'text/event-stream' },
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\\n\\n')) !== -1) {
    const event = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = event.split('\\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const state = JSON.parse(line.slice(6));
    if (state.phase === 'ready') { console.log(state.card); return; }
    if (['failed','refunded','expired','rejected'].includes(state.phase)) {
      throw new Error(state.error ?? state.phase);
    }
  }
}`}
          </CodeBlock>

          <Para>
            The cards402 SDK&apos;s <Code>waitForCard()</Code> already uses this path with polling
            as an automatic fallback, so SDK users get SSE for free. The server emits an SSE comment
            (<Code>: keepalive</Code>) every 15s to prevent intermediate proxies from idle-killing
            the connection.
          </Para>
        </Section>

        <Section id="poll-order">
          <SectionTitle>Poll order (fallback)</SectionTitle>
          <Para>
            Poll the status of an order when SSE isn&apos;t an option (e.g. middleboxes that strip{' '}
            <Code>text/event-stream</Code>). The response is the same shape as each SSE event&apos;s{' '}
            <Code>data:</Code> payload.
          </Para>

          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '0.875rem 1.125rem',
              marginBottom: '1.25rem',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
            }}
          >
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>GET</span>
            <span style={{ color: 'var(--muted)', marginLeft: '0.75rem' }}>/orders/:id</span>
          </div>

          <Para>Suggested poll interval: every 5 seconds for the first 2 minutes.</Para>

          <CodeBlock label="Response — pending">
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "payment_confirmed",
  "phase": "processing",
  "amount_usdc": "25.00",
  "payment_asset": "usdc_soroban",
  "created_at": "2026-04-08T12:00:00.000Z",
  "updated_at": "2026-04-08T12:00:05.000Z"
}`}
          </CodeBlock>

          <CodeBlock label="Response — delivered">
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "delivered",
  "phase": "ready",
  "amount_usdc": "25.00",
  "created_at": "2026-04-08T12:00:00.000Z",
  "updated_at": "2026-04-08T12:01:02.000Z",
  "card": {
    "number": "4111 2345 6789 0123",
    "cvv": "847",
    "expiry": "12/27",
    "brand": "Visa"
  }
}`}
          </CodeBlock>

          <CodeBlock label="Response — failed">
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "failed",
  "phase": "failed",
  "amount_usdc": "25.00",
  "error": "Stage 1 scrape timed out after 3 retries.",
  "created_at": "2026-04-08T12:00:00.000Z",
  "updated_at": "2026-04-08T12:03:15.000Z"
}`}
          </CodeBlock>
        </Section>

        {/* ── Order statuses ── */}
        <Section id="order-statuses">
          <SectionTitle>Order statuses</SectionTitle>
          <Para>
            Orders move through a linear state machine. The happy path ends at{' '}
            <Code>delivered</Code>. Failures produce <Code>failed</Code> and queue a refund.
          </Para>

          <div style={{ overflowX: 'auto', marginBottom: '1.25rem' }}>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {orderStatuses.map(({ status, meaning }) => (
                  <tr key={status}>
                    <td>
                      <span
                        className={`status-${status}`}
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.75rem',
                          padding: '0.2rem 0.55rem',
                          borderRadius: 4,
                          border: '1px solid',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {status}
                      </span>
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Para>
            Phase flow: <Code>awaiting_payment</Code> → <Code>processing</Code> → <Code>ready</Code>
          </Para>
          <Para>
            Failure path: <Code>processing</Code> → <Code>failed</Code> → <Code>refunded</Code>
          </Para>
          <Para>
            No payment within 2 hours: <Code>awaiting_payment</Code> → <Code>expired</Code>
          </Para>
          <Para style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
            Each poll response also includes a <Code>status</Code> field with the internal pipeline
            state (e.g. <Code>ordering</Code>, <Code>stage1_done</Code>). Treat these as
            informational only — build your logic against <Code>phase</Code>, which is stable across
            backend changes.
          </Para>
        </Section>

        {/* ── Webhooks ── */}
        <Section id="webhooks">
          <SectionTitle>Webhooks</SectionTitle>
          <Para>
            If you provide a <Code>webhook_url</Code> when creating an order, cards402 will POST to
            it when the order reaches <Code>delivered</Code> or <Code>failed</Code> status.
          </Para>
          <Para>Each webhook request includes two headers for verification:</Para>
          <ul
            style={{
              color: 'var(--muted)',
              fontSize: '0.9rem',
              lineHeight: 1.7,
              paddingLeft: '1.5rem',
            }}
          >
            <li>
              <Code>X-Cards402-Signature: sha256=&lt;hmac&gt;</Code> — HMAC-SHA256 over{' '}
              <Code>&lt;timestamp&gt;.&lt;body&gt;</Code>
            </li>
            <li>
              <Code>X-Cards402-Timestamp: &lt;unix-ms&gt;</Code> — send time in milliseconds
            </li>
          </ul>
          <Para>
            Always verify the signature and reject requests with a timestamp older than 5 minutes.
            Webhooks are retried automatically on failure: 30 seconds, 5 minutes, then 30 minutes (3
            attempts total). Use polling as your primary status source — webhooks are a convenience
            notification, not a delivery guarantee.
          </Para>

          <SubTitle>Delivered payload</SubTitle>
          <CodeBlock>
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "delivered",
  "card": {
    "number": "4111 2345 6789 0123",
    "cvv": "847",
    "expiry": "12/27",
    "brand": "Visa"
  }
}`}
          </CodeBlock>

          <SubTitle>Failed payload</SubTitle>
          <CodeBlock>
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "failed",
  "error": "Stage 1 scrape timed out after 3 retries."
}`}
          </CodeBlock>

          <SubTitle>Signature verification (Node.js)</SubTitle>
          <CodeBlock>
            {`const { createHmac, timingSafeEqual } = require('crypto');

function verifyWebhook(rawBody, signature, timestamp, secret) {
  if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) return false;
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}`}
          </CodeBlock>

          <Para>
            Return <Code>200</Code> to acknowledge. Any other response is treated as a failure.
          </Para>
        </Section>

        {/* ── Error codes ── */}
        <Section id="errors">
          <SectionTitle>Error codes</SectionTitle>
          <Para>
            All errors return a JSON body with an <Code>error</Code> string and optional{' '}
            <Code>message</Code> field.
          </Para>
          <CodeBlock label="Error shape">
            {`{
  "error": "invalid_amount",
  "message": "amount_usdc must be a positive number"
}`}
          </CodeBlock>

          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>HTTP status</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {errors.map(({ code, status, meaning }) => (
                  <tr key={code}>
                    <td>
                      <Code>{code}</Code>
                    </td>
                    <td
                      style={{
                        color: 'var(--muted)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8125rem',
                      }}
                    >
                      {status}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Rate limits ── */}
        <Section id="rate-limits">
          <SectionTitle>Rate limits</SectionTitle>
          <Para>The following limits are enforced per API key:</Para>
          <ul
            style={{
              color: 'var(--muted)',
              fontSize: '0.9rem',
              lineHeight: 1.7,
              paddingLeft: '1.5rem',
            }}
          >
            <li>
              <strong>Order creation</strong> — 60 per hour
            </li>
            <li>
              <strong>Status polling</strong> — 600 per minute (10/s)
            </li>
          </ul>
          <Para>
            Exceeded limits return <Code>429 rate_limit_exceeded</Code>.
          </Para>
          <Para>
            However, each API key can have an optional <Code>spend_limit_usdc</Code> configured by
            the admin. Once the cumulative spend reaches this limit, the key returns{' '}
            <Code>403 spend_limit_exceeded</Code> until the limit is raised.
          </Para>
          <Para>
            If the fulfillment system has 3 consecutive failures, a circuit breaker freezes all new
            orders and returns <Code>503 service_temporarily_unavailable</Code> until an admin
            manually unfreezes the system.
          </Para>

          <div
            style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid var(--border)' }}
          >
            <p style={{ color: 'var(--muted)', fontSize: '0.875rem', margin: 0 }}>
              Questions?{' '}
              <a
                href="mailto:api@cards402.com"
                style={{ color: 'var(--green)', textDecoration: 'none' }}
              >
                api@cards402.com
              </a>
              {' · '}
              <Link
                href="/agents.txt"
                style={{
                  color: 'var(--muted)',
                  textDecoration: 'none',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                /agents.txt
              </Link>
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}
