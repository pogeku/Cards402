import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyCodeBlock } from '@/app/components/CopyCodeBlock';

export const metadata: Metadata = {
  title: 'API reference',
  description:
    'Full API reference for Cards402: create orders, stream status, verify webhooks, and handle errors.',
  alternates: { canonical: 'https://cards402.com/docs' },
};

// ── Inline primitives ─────────────────────────────────────────────
// The docs page keeps to the same pattern as the landing page: inline
// styles for layout + a trailing <style> block for hover/responsive
// rules the platform doesn't offer inline.

function Code({ children }: { children: string }) {
  return <code className="docs-inline-code">{children}</code>;
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      style={{
        scrollMarginTop: 96,
        paddingTop: '4.25rem',
        marginTop: '0.25rem',
        borderTop: '1px solid var(--border)',
      }}
    >
      <div
        className="type-eyebrow"
        style={{
          color: 'var(--green)',
          marginBottom: '1rem',
        }}
      >
        {eyebrow}
      </div>
      <h2
        className="type-display-tight"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(1.75rem, 2.4vw + 0.6rem, 2.35rem)',
          color: 'var(--fg)',
          margin: '0 0 2rem',
          maxWidth: 640,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontFamily: 'var(--font-body)',
        fontSize: '0.78rem',
        fontWeight: 600,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--fg-dim)',
        margin: '2.25rem 0 0.9rem',
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
        fontFamily: 'var(--font-body)',
        color: 'var(--fg-muted)',
        fontSize: '0.95rem',
        lineHeight: 1.72,
        margin: '0 0 1.1rem',
        maxWidth: 640,
        ...style,
      }}
    >
      {children}
    </p>
  );
}

// Local name reused throughout the STEPS/sections below. The shared
// client component handles the copy-to-clipboard affordance without
// the docs page itself having to become a client component.
const CodeBlock = CopyCodeBlock;

function Endpoint({ method, path }: { method: 'GET' | 'POST'; path: string }) {
  const colors: Record<'GET' | 'POST', { fg: string; border: string; bg: string }> = {
    GET: {
      fg: 'var(--blue)',
      border: 'var(--blue-border)',
      bg: 'var(--blue-muted)',
    },
    POST: {
      fg: 'var(--green)',
      border: 'var(--green-border)',
      bg: 'var(--green-muted)',
    },
  };
  const c = colors[method];
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.85rem',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '0.7rem 0.95rem 0.7rem 0.7rem',
        margin: '0 0 1.5rem',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.84rem',
      }}
    >
      <span
        style={{
          color: c.fg,
          border: `1px solid ${c.border}`,
          background: c.bg,
          borderRadius: 6,
          padding: '0.18rem 0.55rem',
          fontWeight: 600,
          fontSize: '0.72rem',
          letterSpacing: '0.06em',
        }}
      >
        {method}
      </span>
      <span style={{ color: 'var(--fg)' }}>{path}</span>
    </div>
  );
}

// ── Data ───────────────────────────────────────────────────────────

const navSections = [
  {
    title: 'Getting started',
    items: [
      { href: '#authentication', label: 'Authentication', num: '01' },
      { href: '#create-order', label: 'Create order', num: '02' },
    ],
  },
  {
    title: 'Status',
    items: [
      { href: '#stream-order', label: 'Stream (SSE)', num: '03' },
      { href: '#poll-order', label: 'Poll (fallback)', num: '04' },
      { href: '#order-statuses', label: 'Order statuses', num: '05' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '#webhooks', label: 'Webhooks', num: '06' },
      { href: '#errors', label: 'Error codes', num: '07' },
      { href: '#rate-limits', label: 'Rate limits', num: '08' },
    ],
  },
];

// Stable agent-facing phases. Mirrors `OrderPhase` in the SDK
// (sdk/src/client.ts) — keep in sync when adding new phases.
const orderStatuses = [
  {
    status: 'awaiting_approval',
    meaning:
      'Order is held for owner approval because the key has a spend policy that requires it. No payment instructions yet — poll approval_request_id for a decision. Expires after 2 hours.',
  },
  {
    status: 'awaiting_payment',
    meaning:
      'Approved (or no approval needed). Waiting for your Stellar payment to confirm on-chain.',
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
    status: 'rejected',
    meaning:
      'Owner rejected the approval request. The error field contains the decision note. No payment was taken.',
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
    meaning:
      'amount_usdc is missing, not a positive decimal string, or exceeds the per-order cap of $1,000.00.',
  },
  {
    code: 'invalid_webhook_url',
    status: 400,
    meaning:
      'webhook_url failed SSRF validation (non-HTTPS, loopback, private IP, etc.). Use a public HTTPS endpoint.',
  },
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
    code: 'idempotency_conflict',
    status: 409,
    meaning:
      'Idempotency-Key was reused with a different request body. Mint a new key or resend the original body.',
  },
  {
    code: 'rate_limit_exceeded',
    status: 429,
    meaning:
      'Too many orders (60/hour) or too many polls (600/minute). Back off and retry; the window is rolling.',
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
      className="docs-shell"
      style={{
        background: 'var(--bg)',
        color: 'var(--fg)',
        display: 'flex',
        minHeight: 'calc(100vh - 64px)',
        position: 'relative',
      }}
    >
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside className="docs-sidebar">
        <div className="docs-sidebar-inner">
          <div
            className="type-eyebrow"
            style={{
              padding: '0 1.75rem',
              marginBottom: '1.5rem',
              color: 'var(--fg-dim)',
            }}
          >
            API Reference · v1
          </div>

          <nav style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {navSections.map((group) => (
              <div key={group.title}>
                <div
                  style={{
                    padding: '0 1.75rem',
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    color: 'var(--fg-dim)',
                    letterSpacing: '0.01em',
                    marginBottom: '0.45rem',
                  }}
                >
                  {group.title}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {group.items.map((item) => (
                    <a key={item.href} href={item.href} className="docs-nav-link">
                      <span className="docs-nav-num">{item.num}</span>
                      <span>{item.label}</span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div
            style={{
              marginTop: 'auto',
              padding: '1.75rem 1.75rem 0',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.55rem',
            }}
          >
            <div className="type-eyebrow" style={{ fontSize: '0.58rem', color: 'var(--fg-dim)' }}>
              Support
            </div>
            <a
              href="mailto:api@cards402.com"
              style={{
                fontSize: '0.8rem',
                color: 'var(--fg-muted)',
                textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
              }}
            >
              api@cards402.com
            </a>
          </div>
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────── */}
      <div className="docs-main">
        {/* Page header */}
        <header style={{ padding: '4rem 0 3.5rem' }}>
          <div
            className="type-eyebrow"
            style={{
              color: 'var(--green)',
              marginBottom: '1.2rem',
            }}
          >
            Cards402 · HTTP API
          </div>
          <h1
            className="type-display"
            style={{
              fontSize: 'clamp(2.4rem, 4.5vw + 0.5rem, 4rem)',
              color: 'var(--fg)',
              margin: '0 0 1.5rem',
              maxWidth: 720,
            }}
          >
            The{' '}
            <span
              style={{
                fontStyle: 'italic',
                fontVariationSettings: '"opsz" 144, "SOFT" 80',
                color: 'var(--green)',
              }}
            >
              reference
            </span>
            .
          </h1>
          <p
            className="type-body"
            style={{
              fontSize: '1.02rem',
              color: 'var(--fg-muted)',
              maxWidth: 620,
              margin: 0,
            }}
          >
            Everything an agent needs to go from a Stellar payment to a real Visa card. One base
            URL, eight endpoints, zero hosted checkout. Sign in at{' '}
            <Link
              href="/dashboard"
              style={{
                color: 'var(--fg)',
                textDecoration: 'none',
                borderBottom: '1px solid var(--green-border)',
              }}
            >
              /dashboard
            </Link>{' '}
            with your email to mint an API key in seconds.
          </p>

          <div
            style={{
              marginTop: '2.25rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.65rem',
              padding: '0.6rem 0.95rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
            }}
          >
            <span
              style={{
                fontSize: '0.62rem',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--fg-dim)',
              }}
            >
              Base URL
            </span>
            <span style={{ color: 'var(--green)' }}>https://api.cards402.com</span>
          </div>
        </header>

        {/* ── Authentication ── */}
        <Section id="authentication" eyebrow="01 · Authentication" title="One header, one key.">
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
        <Section
          id="create-order"
          eyebrow="02 · Create order"
          title="One transaction in, one card out."
        >
          <Para>
            Creates a new card order and returns Stellar payment instructions. The agent must send
            the exact amount to the Stellar address within the quoted window.
          </Para>

          <Endpoint method="POST" path="/v1/orders" />

          <SubTitle>Request body</SubTitle>
          <Para>
            Content-Type: <Code>application/json</Code>
          </Para>

          <div style={{ margin: '0 0 1.75rem', overflowX: 'auto' }}>
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
                  <td style={{ color: 'var(--fg-muted)' }}>string</td>
                  <td style={{ color: 'var(--fg-muted)' }}>Yes</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    Card value in USD, as a positive decimal string (e.g.{' '}
                    <Code>&quot;25.00&quot;</Code>). Maximum <Code>&quot;1000.00&quot;</Code> per
                    order.
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>webhook_url</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>string</td>
                  <td style={{ color: 'var(--fg-muted)' }}>No</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    HTTPS URL to receive webhook POSTs on status changes.
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>metadata</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>object</td>
                  <td style={{ color: 'var(--fg-muted)' }}>No</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    Arbitrary JSON stored with the order and echoed back on every read.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <Para>
            Asset choice happens at <strong>payment time</strong>, not order creation. The response
            below always carries both a <Code>payment.usdc</Code> quote and a{' '}
            <Code>payment.xlm</Code> quote — call <Code>pay_usdc()</Code> or <Code>pay_xlm()</Code>{' '}
            on the Soroban contract with whichever asset you want to settle in.
          </Para>

          <CodeBlock label="Request">
            {`POST /v1/orders
X-Api-Key: cards402_your_key_here
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "amount_usdc": "25.00",
  "webhook_url": "https://your-agent.com/webhook"
}`}
          </CodeBlock>
          <CodeBlock label="Response — 201 Created">
            {`{
  "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
  "status": "pending_payment",
  "phase": "awaiting_payment",
  "amount_usdc": "25.00",
  "payment": {
    "type": "soroban_contract",
    "contract_id": "CAAAA...cards402_receiver_contract...",
    "order_id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
    "usdc": {
      "amount": "25.0000000",
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

          <SubTitle>Skipping all of this with the CLI</SubTitle>
          <Para>
            Most agents should never talk to the raw API. After{' '}
            <Code>cards402 onboard --claim &lt;code&gt;</Code>, a single command handles
            create-order → sign Soroban tx → stream → return card:
          </Para>
          <CodeBlock label="Shell">
            {`npx cards402 purchase --amount 25
# optional: --asset xlm|usdc
# default is "auto" — picks USDC if the wallet has enough, else XLM`}
          </CodeBlock>

          <SubTitle>USDC vs XLM — which to use?</SubTitle>
          <div style={{ margin: '0 0 1.25rem', overflowX: 'auto' }}>
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
                  <td style={{ color: 'var(--fg-muted)' }}>Card value</td>
                  <td style={{ color: 'var(--fg-muted)' }}>Exact — 1 USDC = $1.00</td>
                  <td style={{ color: 'var(--fg-muted)' }}>Market rate, quoted at order time</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--fg-muted)' }}>Setup</td>
                  <td style={{ color: 'var(--fg-muted)' }}>Requires USDC trustline</td>
                  <td style={{ color: 'var(--fg-muted)' }}>No trustline needed</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--fg-muted)' }}>Wallet needs</td>
                  <td style={{ color: 'var(--fg-muted)' }}>XLM (fees) + USDC balance</td>
                  <td style={{ color: 'var(--fg-muted)' }}>XLM balance only</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--fg-muted)' }}>Predictability</td>
                  <td style={{ color: 'var(--fg-muted)' }}>High — no price risk</td>
                  <td style={{ color: 'var(--fg-muted)' }}>Varies with XLM/USD rate</td>
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
            <Code>phase: &quot;expired&quot;</Code> and no funds are taken. Create a new order to
            retry.
          </Para>

          <SubTitle>Overpayment</SubTitle>
          <Para>
            Send exactly the quoted amount. If you send more than the quoted amount, the excess is
            retained and will not be refunded. Underpayments are not matched — the order will expire
            after 2 hours and no card will be issued.
          </Para>

          <div className="docs-callout">
            <div className="radial-green-glow" aria-hidden />
            <div style={{ position: 'relative' }}>
              <div
                className="type-eyebrow"
                style={{ color: 'var(--green)', marginBottom: '0.6rem' }}
              >
                Using the SDK?
              </div>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.9rem',
                  lineHeight: 1.65,
                  color: 'var(--fg)',
                  margin: 0,
                }}
              >
                Call <Code>purchaseCardOWS()</Code> — it creates the order, signs and submits the
                Soroban transaction, and polls for the card in a single call. No contract
                interaction or order ID handling required.
              </p>
            </div>
          </div>
        </Section>

        {/* ── Stream order ── */}
        <Section
          id="stream-order"
          eyebrow="03 · Stream (SSE)"
          title="Preferred. One open connection, pushed phases."
        >
          <Para>
            Subscribe to live phase updates over Server-Sent Events. One open connection, pushed to
            on every transition, closed cleanly when the order reaches a terminal phase. Prefer this
            over polling for anything that runs as a long-lived process.
          </Para>

          <Endpoint method="GET" path="/orders/:id/stream" />

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

          <CodeBlock label="Minimal client — TypeScript / Node 18+ / browser">
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

          <CodeBlock label="Minimal client — Python 3.10+ / httpx">
            {`import json
import httpx

TERMINAL = {"failed", "refunded", "expired", "rejected"}

def wait_for_card(api_url: str, order_id: str, key: str):
    headers = {"X-Api-Key": key, "Accept": "text/event-stream"}
    url = f"{api_url}/orders/{order_id}/stream"
    with httpx.stream("GET", url, headers=headers, timeout=None) as res:
        buf = ""
        for chunk in res.iter_text():
            buf += chunk
            while "\\n\\n" in buf:
                event, buf = buf.split("\\n\\n", 1)
                data_line = next(
                    (l for l in event.split("\\n") if l.startswith("data: ")),
                    None,
                )
                if not data_line:
                    continue
                state = json.loads(data_line[6:])
                if state["phase"] == "ready":
                    return state["card"]
                if state["phase"] in TERMINAL:
                    raise RuntimeError(state.get("error") or state["phase"])

    raise RuntimeError("stream ended before terminal phase")`}
          </CodeBlock>

          <CodeBlock label="Minimal client — curl">
            {`curl -N \\
  -H "X-Api-Key: cards402_..." \\
  -H "Accept: text/event-stream" \\
  https://api.cards402.com/v1/orders/<order_id>/stream`}
          </CodeBlock>

          <Para>
            The Cards402 SDK&apos;s <Code>waitForCard()</Code> already uses this path with polling
            as an automatic fallback, so SDK users get SSE for free. The server emits an SSE comment
            (<Code>: keepalive</Code>) every 15s to prevent intermediate proxies from idle-killing
            the connection.
          </Para>
        </Section>

        {/* ── Poll order ── */}
        <Section id="poll-order" eyebrow="04 · Poll (fallback)" title="When SSE isn't an option.">
          <Para>
            Poll the status of an order when SSE isn&apos;t an option (e.g. middleboxes that strip{' '}
            <Code>text/event-stream</Code>). The response is the same shape as each SSE event&apos;s{' '}
            <Code>data:</Code> payload.
          </Para>

          <Endpoint method="GET" path="/orders/:id" />

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

          <SubTitle>List orders (recovery / reconciliation)</SubTitle>
          <Para>
            Agents that crash mid-flight can rehydrate state by listing the orders created under
            their key. The response is an array of order summaries ordered by{' '}
            <Code>created_at</Code> descending.
          </Para>

          <Endpoint method="GET" path="/orders" />

          <Para>Optional query parameters:</Para>
          <div style={{ margin: '0 0 1.5rem', overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Param</th>
                  <th>Default</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <Code>limit</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>20</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    Maximum number of results. Capped at 200.
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>offset</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>0</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    Pagination offset for walking historical orders.
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>status</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>any</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    Filter by internal status (e.g. <Code>pending_payment</Code>,{' '}
                    <Code>delivered</Code>).
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>since_created_at</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>—</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    ISO timestamp — only orders created at or after this time.
                  </td>
                </tr>
                <tr>
                  <td>
                    <Code>since_updated_at</Code>
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>—</td>
                  <td style={{ color: 'var(--fg-muted)' }}>
                    ISO timestamp — only orders updated at or after this time. Useful for delta
                    polling without re-fetching the full history.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <CodeBlock label="Response — array of order summaries">
            {`[
  {
    "id": "a3f7c2d1-4e8b-4f0a-9c2d-1b3e5a7f9c0e",
    "status": "delivered",
    "amount_usdc": "25.00",
    "payment_asset": "usdc_soroban",
    "created_at": "2026-04-08T12:00:00.000Z",
    "updated_at": "2026-04-08T12:01:02.000Z"
  },
  {
    "id": "b9e1f3a2-7c4d-4b0e-8f1a-2c4e6a8b0d2f",
    "status": "pending_payment",
    "amount_usdc": "10.00",
    "payment_asset": "usdc_soroban",
    "created_at": "2026-04-08T11:59:12.000Z",
    "updated_at": "2026-04-08T11:59:12.000Z"
  }
]`}
          </CodeBlock>

          <Para style={{ color: 'var(--fg-dim)', fontSize: '0.85rem' }}>
            Note the key shape difference: list items use <Code>id</Code> (not <Code>order_id</Code>
            ) and omit the <Code>phase</Code> field and the <Code>card</Code> object. To retrieve
            card details for a delivered order in the list, call <Code>GET /orders/:id</Code> or use
            the SDK&apos;s <Code>client.getOrder(id)</Code>.
          </Para>
        </Section>

        {/* ── Order statuses ── */}
        <Section id="order-statuses" eyebrow="05 · Order statuses" title="A tiny state machine.">
          <Para>
            Orders move through a linear state machine. The happy path ends at{' '}
            <Code>delivered</Code>. Failures produce <Code>failed</Code> and queue a refund.
          </Para>

          <div style={{ overflowX: 'auto', margin: '0 0 1.5rem' }}>
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
                          fontSize: '0.72rem',
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
                    <td style={{ color: 'var(--fg-muted)', fontSize: '0.86rem' }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Para>
            Happy path: <Code>awaiting_payment</Code> → <Code>processing</Code> → <Code>ready</Code>
          </Para>
          <Para>
            With approval gate: <Code>awaiting_approval</Code> → <Code>awaiting_payment</Code> →{' '}
            <Code>processing</Code> → <Code>ready</Code>
          </Para>
          <Para>
            Failure path: <Code>processing</Code> → <Code>failed</Code> → <Code>refunded</Code>
          </Para>
          <Para>
            Approval rejected: <Code>awaiting_approval</Code> → <Code>rejected</Code>
          </Para>
          <Para>
            No payment within 2 hours: <Code>awaiting_payment</Code> → <Code>expired</Code>
          </Para>
          <Para style={{ color: 'var(--fg-dim)', fontSize: '0.85rem' }}>
            Each poll response also includes a <Code>status</Code> field with the internal pipeline
            state (e.g. <Code>ordering</Code>, <Code>stage1_done</Code>). Treat these as
            informational only — build your logic against <Code>phase</Code>, which is stable across
            backend changes.
          </Para>
        </Section>

        {/* ── Webhooks ── */}
        <Section id="webhooks" eyebrow="06 · Webhooks" title="Signed, retried, optional.">
          <Para>
            If you provide a <Code>webhook_url</Code> when creating an order, Cards402 will POST to
            it when the order reaches <Code>delivered</Code> or <Code>failed</Code> status.
          </Para>
          <Para>Each webhook request includes two headers for verification:</Para>
          <ul
            style={{
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-body)',
              fontSize: '0.92rem',
              lineHeight: 1.7,
              paddingLeft: '1.25rem',
              margin: '0 0 1.1rem',
              maxWidth: 640,
            }}
          >
            <li style={{ marginBottom: '0.35rem' }}>
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

          <SubTitle>Signature verification</SubTitle>
          <CodeBlock label="Node.js">
            {`const { createHmac, timingSafeEqual } = require('crypto');

function verifyWebhook(rawBody, signature, timestamp, secret) {
  if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) return false;
  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}`}
          </CodeBlock>
          <CodeBlock label="Python 3">
            {`import hmac, hashlib, time

def verify_webhook(raw_body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    # Reject anything older than 5 minutes to thwart replay attacks.
    if abs(time.time() * 1000 - int(timestamp)) > 5 * 60 * 1000:
        return False
    message = f"{timestamp}.".encode() + raw_body
    expected = "sha256=" + hmac.new(
        secret.encode(), message, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)`}
          </CodeBlock>

          <Para>
            Return <Code>200</Code> to acknowledge. Any other response is treated as a failure.
          </Para>
        </Section>

        {/* ── Error codes ── */}
        <Section id="errors" eyebrow="07 · Error codes" title="Typed, stable, documented.">
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
                        color: 'var(--fg-muted)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8125rem',
                      }}
                    >
                      {status}
                    </td>
                    <td style={{ color: 'var(--fg-muted)', fontSize: '0.86rem' }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Rate limits ── */}
        <Section id="rate-limits" eyebrow="08 · Rate limits" title="Per-key, per-hour, per-minute.">
          <Para>The following limits are enforced per API key:</Para>
          <ul
            style={{
              color: 'var(--fg-muted)',
              fontFamily: 'var(--font-body)',
              fontSize: '0.92rem',
              lineHeight: 1.7,
              paddingLeft: '1.25rem',
              margin: '0 0 1.1rem',
              maxWidth: 640,
            }}
          >
            <li style={{ marginBottom: '0.35rem' }}>
              <strong style={{ color: 'var(--fg)' }}>Order creation</strong> — 60 per hour
            </li>
            <li>
              <strong style={{ color: 'var(--fg)' }}>Status polling</strong> — 600 per minute (10/s)
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

          <SubTitle>Check your current usage</SubTitle>
          <Para>
            Call <Code>GET /usage</Code> to get the current budget and order counts for your key.
            The SDK exposes this as <Code>client.getUsage()</Code>.
          </Para>

          <Endpoint method="GET" path="/usage" />

          <CodeBlock label="Response">
            {`{
  "api_key_id": "ak_a3f7c2d1",
  "label": "production-agent",
  "budget": {
    "spent_usdc": "15.00",
    "limit_usdc": "100.00",
    "remaining_usdc": "85.00"
  },
  "orders": {
    "total": 3,
    "delivered": 2,
    "failed": 0,
    "refunded": 1,
    "in_progress": 0
  }
}`}
          </CodeBlock>

          <Para>
            The <Code>budget.limit_usdc</Code> field is <Code>null</Code> for keys without a spend
            limit configured; in that case <Code>remaining_usdc</Code> is also <Code>null</Code> and
            only the global 60 orders/hour rate limit applies.
          </Para>
        </Section>

        {/* ── Footer tail ── */}
        <div
          style={{
            marginTop: '5rem',
            paddingTop: '2.25rem',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <p
            style={{
              color: 'var(--fg-dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
              margin: 0,
            }}
          >
            Questions?{' '}
            <a
              href="mailto:api@cards402.com"
              style={{ color: 'var(--green)', textDecoration: 'none' }}
            >
              api@cards402.com
            </a>
          </p>
          <Link href="/agents.txt" className="link-arrow" style={{ fontSize: '0.72rem' }}>
            Read /agents.txt
          </Link>
        </div>
      </div>

      {/* ── Docs-local styles ─────────────────────────────────── */}
      <style>{`
        .docs-sidebar {
          width: 260px;
          flex-shrink: 0;
          border-right: 1px solid var(--border);
          position: sticky;
          top: 64px;
          align-self: flex-start;
          height: calc(100vh - 64px);
          overflow-y: auto;
          z-index: 1;
        }
        .docs-sidebar-inner {
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 2.25rem 0 1.75rem;
        }
        .docs-main {
          flex: 1;
          min-width: 0;
          padding: 0 3rem 6rem;
          max-width: 820px;
        }
        .docs-nav-link {
          display: flex;
          align-items: baseline;
          gap: 0.65rem;
          padding: 0.45rem 1.75rem;
          font-family: var(--font-body);
          font-size: 0.86rem;
          color: var(--fg-muted);
          text-decoration: none;
          position: relative;
          transition:
            color 0.3s var(--ease-out),
            background 0.3s var(--ease-out);
        }
        .docs-nav-link::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0.7rem;
          bottom: 0.7rem;
          width: 2px;
          background: var(--green);
          box-shadow: 0 0 12px var(--green-glow);
          transform: scaleY(0);
          transform-origin: center;
          transition: transform 0.3s var(--ease-out);
        }
        .docs-nav-link:hover {
          color: var(--fg);
          background: var(--surface-hover);
        }
        .docs-nav-link:hover::before {
          transform: scaleY(1);
        }
        .docs-nav-num {
          font-family: var(--font-mono);
          font-size: 0.64rem;
          color: var(--fg-dim);
          letter-spacing: 0.05em;
        }
        .docs-inline-code {
          font-family: var(--font-mono);
          font-size: 0.82em;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 0.1em 0.38em;
          color: var(--green);
          white-space: nowrap;
        }
        .docs-callout {
          position: relative;
          overflow: hidden;
          background: var(--surface);
          border: 1px solid var(--green-border);
          border-radius: 12px;
          padding: 1.25rem 1.5rem;
          margin: 0.25rem 0 1.5rem;
          max-width: 640px;
        }
        .docs-callout .radial-green-glow {
          opacity: 0.18;
        }
        .docs-main section:first-of-type {
          border-top: none;
        }

        @media (max-width: 960px) {
          .docs-shell {
            flex-direction: column !important;
          }
          .docs-sidebar {
            width: 100% !important;
            position: sticky;
            top: 64px;
            height: auto !important;
            border-right: none !important;
            border-bottom: 1px solid var(--border);
            background: rgba(5, 5, 5, 0.82);
            backdrop-filter: blur(16px) saturate(140%);
            -webkit-backdrop-filter: blur(16px) saturate(140%);
          }
          .docs-sidebar-inner {
            flex-direction: row;
            align-items: center;
            gap: 1.25rem;
            padding: 0.75rem 1.35rem;
            overflow-x: auto;
            height: auto;
          }
          .docs-sidebar-inner > div:first-child {
            display: none;
          }
          .docs-sidebar nav {
            flex-direction: row !important;
            gap: 0.25rem !important;
            flex-wrap: nowrap;
          }
          .docs-sidebar nav > div > div:first-child {
            display: none;
          }
          .docs-sidebar nav > div {
            display: flex;
            align-items: center;
          }
          .docs-sidebar nav > div > div:last-child {
            flex-direction: row !important;
          }
          .docs-nav-link {
            padding: 0.45rem 0.75rem !important;
            white-space: nowrap;
          }
          .docs-nav-link::before {
            display: none;
          }
          .docs-sidebar-inner > div:last-child {
            display: none;
          }
          .docs-main {
            padding: 0 1.75rem 5rem !important;
            max-width: 100% !important;
          }
        }

        @media (max-width: 560px) {
          .docs-main {
            padding: 0 1.1rem 4rem !important;
          }
          .docs-main header {
            padding: 2.5rem 0 2.25rem !important;
          }
        }
      `}</style>
    </div>
  );
}
