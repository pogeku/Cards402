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
import { onboardAgent, getOWSBalance } from '@ctx.com/cards402';

// One call: reports 'initializing' to the backend, creates (or
// fetches) the encrypted wallet, reports 'awaiting_funding' with
// the wallet address, returns the public key + balance.
// Idempotent — safe to call on every startup.
const { publicKey, balance } = await onboardAgent({
  apiKey: process.env.CARDS402_API_KEY,
  walletName: 'my-agent',
});
console.log('Fund this Stellar address:', publicKey);
console.log(`Current balance: ${balance.xlm} XLM  ${balance.usdc} USDC`);
```

**The operator sees your setup progress live** in their cards402
dashboard — as soon as `onboardAgent` runs, your key moves through
the state pill from "Minted" → "Setting up" → "Awaiting deposit".
They'll know to fund the address without you having to message them
separately.

**Ask your operator to fund `publicKey`** with however much USDC or
XLM you need for your intended purchases, plus ~2 XLM to cover the
Stellar account reserve and fees. There is no minimum top-up beyond
that — send what you actually need.

Once they've funded, re-check the balance on demand:

```javascript
const balance = await getOWSBalance('my-agent');
console.log(`XLM: ${balance.xlm}  USDC: ${balance.usdc}`);
```

When you make your first successful purchase, the backend automatically
flips your state to "Active" — no extra reporting required.

### ⚠ Persisting your wallet

This is the part that will bite you if you ignore it.

OWS stores the encrypted wallet file on disk — by default at
`~/.ows/wallets/<name>.vault` — and that file is what holds the keys
that control the Stellar address you just funded. **If the vault file
disappears, the funds in that address are unreachable.** There is no
server-side recovery; cards402 never sees your private keys.

Before you run `createOWSWallet` for the first time, check where
`~/.ows/wallets/` actually lives on your runtime and whether that
location survives a restart:

- **Long-lived VM, your own laptop, persistent container:** `~` is
  your real home directory. Default vault location is fine. No action
  needed.
- **Serverless (Lambda, Cloud Run, Vercel Functions), scratch
  sandboxes, ephemeral dev containers, Replit without persistence:**
  `~` resets between invocations or on every restart. You **must**
  point OWS at a persistent volume or you'll lose every wallet you
  create. Set the `OWS_VAULT_PATH` environment variable (or pass
  `vaultPath` as the third argument to `createOWSWallet`) to a path
  on a mounted volume that survives restarts — e.g. `/data/ows` on
  a docker-compose volume, or a path under an EFS mount on Lambda.
- **Not sure?** Tell your operator which runtime you're in and ask
  them where persistent storage lives. Better to pause here than to
  lose funds later.

```javascript
// Example: explicit persistent vault path
const { publicKey } = createOWSWallet('my-agent', undefined, '/data/ows');
```

The wallet is encrypted at rest. If you also pass a `passphrase` to
`createOWSWallet`, an attacker who gets hold of the vault file still
can't spend without the passphrase. Recommended when the vault path
is on shared storage.

**Reference material your operator may want to read:**

- OWS vault format and CLI: <https://github.com/CTX-com/Stellar-OWS-Core>
- Stellar account activation minimums: <https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance>

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
