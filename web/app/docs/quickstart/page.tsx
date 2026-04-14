import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyCodeBlock } from '@/app/components/CopyCodeBlock';

export const metadata: Metadata = {
  title: 'Quickstart',
  description:
    'Issue your first Cards402 card in five minutes. Install the SDK, claim a key, pay a Soroban contract, stream the card.',
  alternates: { canonical: 'https://cards402.com/docs/quickstart' },
};

// BreadcrumbList JSON-LD — tells Google this page sits Docs → Quickstart
// so the SERP shows the hierarchy instead of a raw URL.
const breadcrumbJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Docs',
      item: 'https://cards402.com/docs',
    },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Quickstart',
      item: 'https://cards402.com/docs/quickstart',
    },
  ],
};

// HowTo JSON-LD — the quickstart is a literal 5-step guide, which
// is the exact shape Google renders as a numbered rich result on
// developer search queries. Keep the step names in sync with the
// STEPS array below if it's ever renumbered.
const howToJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'Issue your first Cards402 card in five minutes',
  description:
    'Install the Cards402 SDK, claim an API key, fund a Stellar wallet, purchase a card, and wire it into an agent runtime.',
  totalTime: 'PT5M',
  supply: [
    { '@type': 'HowToSupply', name: 'A Cards402 claim code from an operator' },
    { '@type': 'HowToSupply', name: 'Stellar wallet with USDC or XLM' },
  ],
  tool: [
    { '@type': 'HowToTool', name: 'Node.js 18+' },
    { '@type': 'HowToTool', name: 'npm, pnpm, or bun' },
  ],
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Install the SDK',
      text: 'Run npm install cards402 — the single package ships the TypeScript SDK, the CLI, and the MCP server.',
      url: 'https://cards402.com/docs/quickstart#install-the-sdk',
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Claim your first API key',
      text: 'Exchange a single-use claim code for an API key via npx cards402 onboard --claim c402_<code>.',
      url: 'https://cards402.com/docs/quickstart#claim-your-first-api-key',
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Fund a wallet',
      text: 'Create a Stellar wallet via createOWSWallet() and fund it with at least 2 XLM. The SDK auto-adds a USDC trustline on first USDC purchase.',
      url: 'https://cards402.com/docs/quickstart#fund-a-wallet',
    },
    {
      '@type': 'HowToStep',
      position: 4,
      name: 'Purchase your first card',
      text: 'Call purchaseCardOWS() with the API key, wallet name, and USD amount. The SDK creates the order, signs the Soroban payment, and resolves with the card PAN, CVV, and expiry.',
      url: 'https://cards402.com/docs/quickstart#purchase-your-first-card',
    },
    {
      '@type': 'HowToStep',
      position: 5,
      name: 'Wire it into your agent',
      text: 'Add the Cards402 MCP server to your claude_desktop_config.json or other MCP host so the purchase_vcc tool is available to the LLM.',
      url: 'https://cards402.com/docs/quickstart#wire-it-into-your-agent',
    },
  ],
};

function Code({ children }: { children: string }) {
  return (
    <code
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.82em',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '0.1em 0.38em',
        color: 'var(--green)',
      }}
    >
      {children}
    </code>
  );
}

// Alias the shared component to the local name the STEPS array
// expects. Keeps the diff tight — every <CodeBlock> inside STEPS
// now renders with a copy-to-clipboard button in the corner.
const CodeBlock = CopyCodeBlock;

const STEPS = [
  {
    n: '01',
    title: 'Install the SDK',
    body: (
      <>
        <p>
          Cards402 ships as a single npm package with an included CLI. One install gets you the
          TypeScript SDK, the CLI, and the MCP server.
        </p>
        <CodeBlock label="Shell">{`npm install cards402
# or: pnpm add cards402 / bun add cards402`}</CodeBlock>
        <p>
          The package exports <Code>purchaseCardOWS</Code>, <Code>createOrder</Code>,{' '}
          <Code>waitForCard</Code>, and a <Code>Cards402</Code> client class for lower-level usage.
        </p>
      </>
    ),
  },
  {
    n: '02',
    title: 'Claim your first API key',
    body: (
      <>
        <p>
          Sign in to the <Link href="/dashboard">dashboard</Link> with any email (you&apos;ll get a
          6-digit login code by return) and open the <strong>Keys</strong> tab. Click{' '}
          <strong>New key</strong>, name it, and copy the token — it&apos;s only shown once.
        </p>
        <p>Prefer not to paste the raw key into agent context? Use a claim code instead:</p>
        <CodeBlock label="Shell">{`npx cards402 onboard --claim c402_abc123...`}</CodeBlock>
        <p>
          Claim codes are single-use. The agent exchanges one for a real API key on first run and
          invalidates the claim in the same round trip. Credentials never appear in the LLM
          transcript.
        </p>
      </>
    ),
  },
  {
    n: '03',
    title: 'Fund a wallet',
    body: (
      <>
        <p>
          Your agent pays the receiver contract directly, so it needs a Stellar wallet with at least
          2 XLM for the native account reserve (plus a second XLM of slack if you plan to settle in
          USDC — the extra XLM covers the one-time USDC trustline entry). The SDK creates the wallet
          for you, stored encrypted in an OWS vault:
        </p>
        <CodeBlock label="TypeScript">{`import { createOWSWallet, getOWSBalance } from 'cards402';

// Creates or loads a vault entry for 'my-agent'. Idempotent.
const { walletId, publicKey } = createOWSWallet('my-agent');
console.log('Send at least 2 XLM to', publicKey);

// Check the balance whenever you need to.
const { xlm, usdc } = await getOWSBalance('my-agent');`}</CodeBlock>
        <p>
          You don&apos;t need to set up a USDC trustline manually. If you call{' '}
          <Code>purchaseCardOWS</Code> with <Code>paymentAsset: &apos;usdc&apos;</Code> and the
          wallet doesn&apos;t have a trustline yet, the SDK adds it automatically as long as the
          wallet has at least 2 XLM for fees + reserve. XLM-only agents can skip this entirely.
        </p>
        <p>
          Cards402 never sees or touches the secret key — it lives in an encrypted OWS vault on the
          machine running the SDK, protected by an optional passphrase. The same vault is what the
          MCP server uses, so Claude Desktop and your TypeScript code share one wallet identity.
        </p>
      </>
    ),
  },
  {
    n: '04',
    title: 'Purchase your first card',
    body: (
      <>
        <p>
          One SDK call creates the order, signs the Soroban payment, streams the fulfilment phases,
          and resolves with the card:
        </p>
        <CodeBlock label="TypeScript">{`import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: 'my-agent',
  amountUsdc: '25.00',
  paymentAsset: 'xlm',  // or 'usdc' (default)
});

console.log(card);
// {
//   number: '4111 2345 6789 0123',
//   cvv: '847',
//   expiry: '12/27',
//   brand: 'Visa',
//   order_id: 'a3f7c2d1-...'
// }`}</CodeBlock>
        <p>
          That&apos;s it. A real Visa card, sixty seconds from a stablecoin payment, no hosted
          checkout, no human in the loop.
        </p>
      </>
    ),
  },
  {
    n: '05',
    title: 'Wire it into your agent',
    body: (
      <>
        <p>
          Cards402 ships an MCP server so Claude Desktop and any other MCP-aware runtime can call it
          as a tool. Add it to your MCP config:
        </p>
        <CodeBlock label="claude_desktop_config.json">{`{
  "mcpServers": {
    "cards402": {
      "command": "npx",
      "args": ["cards402", "mcp"],
      "env": {
        "CARDS402_API_KEY": "cards402_..."
      }
    }
  }
}`}</CodeBlock>
        <p>
          Restart Claude Desktop and the <Code>purchase_vcc</Code> tool is now available alongside{' '}
          <Code>setup_wallet</Code>, <Code>check_order</Code>, and <Code>check_budget</Code>. The
          LLM can trigger an order, sign the Stellar payment, and get the card number in a single
          turn.
        </p>
      </>
    ),
  },
];

export default function QuickstartPage() {
  return (
    <div
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '4.5rem 1.75rem 6rem',
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([breadcrumbJsonLd, howToJsonLd]),
        }}
      />
      <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '1.1rem' }}>
        Docs · Quickstart · 5 minutes
      </div>
      <h1
        className="type-display"
        style={{
          fontSize: 'clamp(2.1rem, 3.5vw + 0.5rem, 3.25rem)',
          color: 'var(--fg)',
          margin: '0 0 1.35rem',
        }}
      >
        From zero to a real Visa card in{' '}
        <span
          style={{
            fontStyle: 'italic',
            fontVariationSettings: '"opsz" 144, "SOFT" 80',
            color: 'var(--green)',
          }}
        >
          five
        </span>{' '}
        minutes.
      </h1>
      <p
        className="type-body"
        style={{
          fontSize: '1rem',
          color: 'var(--fg-muted)',
          maxWidth: 620,
          margin: '0 0 3.25rem',
        }}
      >
        This walk-through covers a full Cards402 integration from scratch: install the SDK, claim a
        key, fund a wallet, issue a card, and wire it into an agent runtime. Copy-pasteable at every
        step.
      </p>

      {STEPS.map((s, i) => (
        <section
          id={s.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')}
          key={s.n}
          style={{
            paddingTop: i === 0 ? '2.5rem' : '3rem',
            marginTop: i === 0 ? '1rem' : 0,
            borderTop: '1px solid var(--border)',
            scrollMarginTop: 96,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '0.9rem',
              marginBottom: '1.15rem',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.72rem',
                color: 'var(--green)',
                letterSpacing: '0.1em',
              }}
            >
              {s.n}
            </span>
            <h2
              className="type-display-tight"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.55rem, 2.4vw + 0.4rem, 2.1rem)',
                color: 'var(--fg)',
                margin: 0,
                letterSpacing: '-0.02em',
              }}
            >
              {s.title}
            </h2>
          </div>
          <div
            className="quickstart-body"
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '0.95rem',
              lineHeight: 1.72,
              color: 'var(--fg-muted)',
            }}
          >
            {s.body}
          </div>
        </section>
      ))}

      {/* Next steps */}
      <section
        style={{
          marginTop: '5rem',
          padding: '2.5rem 2.25rem',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
        }}
      >
        <div className="type-eyebrow" style={{ color: 'var(--green)', marginBottom: '0.85rem' }}>
          Next steps
        </div>
        <h2
          className="type-display-tight"
          style={{
            fontSize: '1.7rem',
            color: 'var(--fg)',
            margin: '0 0 1.5rem',
          }}
        >
          Where to go from here.
        </h2>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
          {[
            {
              href: '/docs',
              label: 'Full HTTP API reference',
              body: 'Every endpoint, every field, every error code.',
            },
            {
              href: '/pricing',
              label: 'Pricing and limits',
              body: 'Fees, spend caps, and the issuer terms.',
            },
            {
              href: '/security',
              label: 'Security posture',
              body: 'How keys, webhooks, and infra are locked down.',
            },
            {
              href: '/dashboard',
              label: 'Open the dashboard',
              body: 'Create a key, inspect orders, watch spend in real time.',
            },
          ].map((x) => (
            <li key={x.href}>
              <Link
                href={x.href}
                style={{
                  display: 'block',
                  padding: '1.1rem 1.15rem',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  textDecoration: 'none',
                  color: 'var(--fg)',
                  transition: 'border-color 0.3s var(--ease-out)',
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: '1rem',
                    fontWeight: 500,
                    marginBottom: '0.35rem',
                    letterSpacing: '-0.015em',
                  }}
                >
                  {x.label} →
                </div>
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--fg-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  {x.body}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <style>{`
        .quickstart-body p { margin: 0 0 1rem; }
        .quickstart-body p:last-child { margin-bottom: 0; }
        .quickstart-body a {
          color: var(--fg);
          text-decoration: none;
          border-bottom: 1px solid var(--green-border);
        }
      `}</style>
    </div>
  );
}
