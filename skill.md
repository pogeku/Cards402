# cards402 — Virtual Visa Cards for AI Agents

Purchase prepaid Visa virtual cards by paying with XLM or USDC on Stellar.
Cards are delivered in 30–60 seconds.

## What your operator gives you

- **key** — your API key (starts with `cards402_`)
- **api_url** — e.g. `https://api.cards402.com/v1`

Store these as `CARDS402_API_KEY` and `CARDS402_BASE_URL`. That's it.

## Setup — Node.js (recommended)

One package. No CLI install, no `curl | bash`. The wallet is created
in-process via native bindings that ship with the SDK.

```bash
npm install @ctx.com/cards402
```

```javascript
import { createOWSWallet, getOWSBalance } from '@ctx.com/cards402';

// Creates a new encrypted Stellar wallet in the default OWS vault
// (~/.ows/vault/<name>.vault). Idempotent — returns the existing
// wallet if one with this name already exists.
const { publicKey } = createOWSWallet('my-agent');
console.log('Fund this Stellar address:', publicKey);

// Wait for your operator to send funds, then check:
const balance = await getOWSBalance('my-agent');
console.log(`XLM: ${balance.xlm}  USDC: ${balance.usdc}`);
```

**Ask your operator to fund `publicKey`** with however much USDC or
XLM you need for your intended purchases, plus ~2 XLM to cover the
Stellar account reserve and fees. There is no minimum top-up beyond
that — send what you actually need.

## Purchasing a card

Purchasing a card is a **real financial transaction** — only do it when
your user explicitly asks, and only for the amount they ask for. Do
not run this as part of setup, testing, or on your own initiative.

```javascript
import { purchaseCardOWS } from '@ctx.com/cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY,
  baseUrl: process.env.CARDS402_BASE_URL,
  walletName: 'my-agent',
  amountUsdc: '<amount the user requested>',
  paymentAsset: 'xlm', // or 'usdc'
});

console.log('Card:', card.number, 'CVV:', card.cvv, 'Exp:', card.expiry);
```

Under the hood, `purchaseCardOWS` opens a single SSE stream to
`/v1/orders/:id/stream`, waits for the `ready` event, and returns the
card details. No polling, no webhook endpoint required.

## Setup — MCP (Claude Desktop, Cursor, other MCP clients)

If your runtime is an MCP client, add this to your config:

```json
{
  "mcpServers": {
    "cards402": {
      "command": "npx",
      "args": ["-y", "@ctx.com/cards402"],
      "env": { "CARDS402_API_KEY": "cards402_<your key>" }
    }
  }
}
```

The MCP server exposes four tools: `setup_wallet`, `check_budget`,
`check_order`, and `purchase_vcc`. Run `setup_wallet` first to see
your wallet's Stellar address for funding; only call `purchase_vcc`
when the user explicitly asks for a card.

## Setup — non-Node agents (Python, Go, shell, etc.)

You can't use the SDK, so you'll need to:

1. Install the OWS CLI for wallet management:

   ```bash
   curl -fsSL https://cards402.com/install-ows.sh | bash
   ows wallet create --name my-agent
   ```

   Installs from the pinned release at
   `github.com/CTX-com/Stellar-OWS-Core`. Inspect the script first if
   your security policy requires it.

2. Call the HTTP API directly. Full protocol reference including the
   SSE streaming path, raw Soroban contract invocation, and phase
   transitions: https://cards402.com/agents.txt

## Quick reference

| Action               | Command                                                   |
| -------------------- | --------------------------------------------------------- |
| Check wallet balance | `ows wallet get --name my-agent`                          |
| Check spend budget   | `curl $API_URL/usage -H "X-Api-Key: $KEY"`                |
| Stream order updates | `curl -N $API_URL/orders/$ID/stream -H "X-Api-Key: $KEY"` |
| Get order snapshot   | `curl $API_URL/orders/$ID -H "X-Api-Key: $KEY"`           |
| List recent orders   | `curl $API_URL/orders -H "X-Api-Key: $KEY"`               |

The SDK's `purchaseCardOWS` subscribes to the live SSE stream under the
hood — one open connection, push notifications, closes cleanly when the
card is ready. No polling, no webhook endpoint to host. If you're
calling the API without the SDK, open `GET /orders/{id}/stream` with
`Accept: text/event-stream` and read events until you see
`phase: "ready"`. Full protocol details: https://cards402.com/agents.txt

## Errors

| Error                             | What to do                        |
| --------------------------------- | --------------------------------- |
| `insufficient_balance`            | Ask operator for more XLM         |
| `spend_limit_exceeded`            | Hit your daily/total budget       |
| `policy_requires_approval`        | Operator must approve this amount |
| `service_temporarily_unavailable` | Retry in a minute                 |

## Timing

Order → payment → card: **30–60 seconds**
