# cards402 — Agent Guide

cards402 issues prepaid Visa virtual cards on demand. AI agents pay USDC or XLM on Stellar via a smart contract and get back a card number, CVV, and expiry — ready to use for online purchases.

## Quick orientation

- **API base**: `https://api.cards402.com/v1`
- **Auth**: `X-Api-Key: cards402_...` header on every request
- **Payment**: Stellar network — USDC or XLM via Soroban contract call
- **Typical latency**: 45–120 seconds from payment confirmation to card delivery
- **SDK**: `npm install cards402` — includes MCP server and `purchaseCardOWS()` all-in-one

## Core flow

```
POST /v1/orders          → get Soroban contract payment instructions
  ↓
Call contract.pay_usdc() or contract.pay_xlm()   → send funds to receiver contract
  ↓
GET /v1/orders/:id       → poll until phase = "ready"
  ↓
Use card.number, card.cvv, card.expiry
```

## Creating an order

```http
POST /v1/orders
X-Api-Key: cards402_...
Content-Type: application/json
Idempotency-Key: <uuid>     ← always send this; safe to retry on network error

{
  "amount_usdc": "25.00",
  "webhook_url": "https://your-app.com/webhook"   ← optional
}
```

The asset is **not** chosen at order-creation time — every response
includes both a USDC and an XLM quote, and the agent picks which one to
pay by invoking either `pay_usdc` or `pay_xlm` on the receiver contract.
A `payment_asset` field on this request is silently ignored by the
backend; older drafts of this doc said otherwise (see audit F14).

**Response:**

```json
{
  "order_id": "uuid",
  "status": "pending_payment",
  "payment": {
    "type": "soroban_contract",
    "contract_id": "C...",                      ← Cards402 receiver contract ID
    "order_id": "uuid",                         ← pass this to the contract call
    "usdc": {
      "amount": "25.00",                        ← USDC amount (7-decimal string)
      "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    },
    "xlm": { "amount": "161.2903226" }          ← XLM quote, always present
  },
  "poll_url": "/v1/orders/uuid",
  "budget": {
    "spent_usdc": "15.00",
    "limit_usdc": "100.00",
    "remaining_usdc": "85.00"
  }
}
```

Both `usdc` and `xlm` quotes are returned on every response. The agent picks
one and invokes either `pay_usdc` or `pay_xlm` on the receiver contract — the
SDK helpers pick the right function based on `paymentAsset`.

## Sending the payment

Use the SDK's `purchaseCardOWS()` which does everything in one call:

```typescript
import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: process.env.OWS_WALLET_NAME!,
  amountUsdc: '25.00',
  paymentAsset: 'usdc', // or 'xlm'
});
// card: { number, cvv, expiry, brand, order_id }
```

Or step by step with `payViaContractOWS()` — pass the `payment` object from
the `POST /v1/orders` response directly:

```typescript
import { Cards402Client, payViaContractOWS } from 'cards402';

const client = new Cards402Client({ apiKey: process.env.CARDS402_API_KEY! });
const order = await client.createOrder({ amount_usdc: '25.00' });

const txHash = await payViaContractOWS({
  walletName: process.env.OWS_WALLET_NAME!,
  payment: order.payment,
  paymentAsset: 'usdc', // or 'xlm'
});

const card = await client.waitForCard(order.order_id);
```

The same `payViaContractOWS` call handles both USDC and XLM — it reads
`payment.usdc.amount` or `payment.xlm.amount` based on `paymentAsset` and
invokes `pay_usdc` / `pay_xlm` on the receiver contract.

If you're using a raw Stellar secret instead of an OWS wallet, replace
`payViaContractOWS` with `payViaContract` and pass `walletSecret` instead of
`walletName`.

## Polling for the card

```http
GET /v1/orders/:id
X-Api-Key: cards402_...
```

**Response when ready:**

```json
{
  "order_id": "uuid",
  "status": "delivered",
  "phase": "ready",
  "amount_usdc": "25.00",
  "card": {
    "number": "4111111111111111",
    "cvv": "123",
    "expiry": "12/27",
    "brand": "Visa"
  }
}
```

**Phase values** (stable, use these in your code):

| Phase               | Meaning                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaiting_approval` | Order is held for owner approval (triggered by spend policy). Poll `approval_request_id` to watch for a decision; no payment instructions yet. |
| `awaiting_payment`  | Ready to be paid. Response includes `payment` — call the receiver contract.                                                                    |
| `processing`        | Payment detected on-chain; fulfillment in progress.                                                                                            |
| `ready`             | Card delivered — check `card` object.                                                                                                          |
| `failed`            | Fulfillment failed — check `error`; refund queued if possible.                                                                                 |
| `refunded`          | USDC refunded — check `refund.stellar_txid`.                                                                                                   |
| `rejected`          | Owner rejected the approval request; `error` contains the decision note.                                                                       |
| `expired`           | Payment window expired (2 hours); no funds taken.                                                                                              |

## Order lifecycle

```
awaiting_approval → awaiting_payment → processing → ready
      ↓ rejected              ↓ expired    ↓ failed → refunded
```

Agents should only care about the `phase` field (not the internal `status`).
The internal status has more granularity for debugging.

## Polling recommendations

- Poll every 3–5 seconds until `phase` is terminal (`ready`, `failed`, `refunded`, `rejected`, `expired`).
- `awaiting_approval` can last up to 2 hours — check `expires_at` on the response and back off polling (e.g. every 30s).
- Set a client-side timeout (5–10 minutes for the payment phase) and handle `WaitTimeoutError` from the SDK.
- Use `client.waitForCard(orderId)` from the SDK — it handles terminal phases and timeouts for you.

## Webhook events

Optionally provide `webhook_url` in `POST /v1/orders`. cards402 will POST to that URL on delivery or failure.

**Delivery event:**

```json
{
  "order_id": "uuid",
  "status": "delivered",
  "card": { "number": "...", "cvv": "...", "expiry": "...", "brand": "Visa" }
}
```

**Failure event:**

```json
{
  "order_id": "uuid",
  "status": "failed",
  "error": "human-readable error message"
}
```

Webhooks include `X-Cards402-Signature: sha256=<hmac>` and `X-Cards402-Timestamp: <unix-ms>` headers. The signature covers `<timestamp>.<body>` — verify the HMAC and reject if the timestamp is >5 minutes old.

**Delivery guarantees.** Webhook delivery is best-effort but retried. Each
event is attempted immediately; on any non-2xx response or network error,
cards402 queues a retry on an exponential backoff (~30s, ~5m, ~30m) for up to
three total attempts (about 35 minutes end-to-end). After the final failure,
the event is marked abandoned and not retried. **Your handler must be
idempotent** — the same event may arrive more than once, and the signature
plus `order_id` + terminal `status` let you dedupe safely.

## Checking your budget

```http
GET /v1/usage
X-Api-Key: cards402_...
```

```json
{
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
}
```

Use `client.getUsage()` in the SDK or call the `check_budget` MCP tool.

## Error responses

All errors return `{ "error": "error_code", "message": "..." }`.

| HTTP | error                             | Meaning                                         |
| ---- | --------------------------------- | ----------------------------------------------- |
| 400  | `invalid_amount`                  | `amount_usdc` must be a positive number ≤ $1000 |
| 400  | `invalid_webhook_url`             | webhook URL failed SSRF validation              |
| 401  | `missing_api_key`                 | No `X-Api-Key` header                           |
| 401  | `invalid_api_key`                 | Key not found or disabled                       |
| 403  | `spend_limit_exceeded`            | Would exceed the key's spend limit              |
| 404  | `order_not_found`                 | Order doesn't exist or belongs to another key   |
| 429  | `rate_limit_exceeded`             | 60 orders/hour or 600 polls/min exceeded        |
| 503  | `service_temporarily_unavailable` | System frozen after repeated failures           |

## Idempotency

Always send `Idempotency-Key: <uuid>` on `POST /v1/orders`. If the request fails at the network level and you retry with the same key within 24 hours, you'll get the original response — not a duplicate order.

## Wallet setup

Cards402 agents use OWS (Open Wallet Standard) — keys are stored encrypted in a local vault file, never as plaintext env vars.

1. **Set env vars**:
   ```
   OWS_WALLET_NAME=my-agent       # wallet identifier
   OWS_WALLET_PASSPHRASE=secret   # encryption passphrase (recommended)
   CARDS402_API_KEY=cards402_...  # your API key from cards402.com
   ```
2. **Create the wallet** — run `setup_wallet` via MCP, or:
   ```typescript
   import { createOWSWallet } from 'cards402';
   const { publicKey } = createOWSWallet('my-agent', process.env.OWS_WALLET_PASSPHRASE);
   ```
3. **Send at least 2 XLM** to the public key — activates the Stellar account and covers network reserves.
4. **Run `setup_wallet` again** — the USDC trustline is added automatically once the account has XLM. No manual trustline step needed.
5. **Fund with USDC** (if paying with USDC) — or just top up XLM to pay with native XLM. The asset choice happens at payment time (`pay_usdc` vs `pay_xlm` on the receiver contract), not at order creation.

The vault file lives at `~/.ows/vault` by default. Set `OWS_VAULT_PATH` to override.

## MCP server

For Claude Desktop, Cursor, or any MCP host:

```json
{
  "mcpServers": {
    "cards402": {
      "command": "npx",
      "args": ["cards402"],
      "env": {
        "CARDS402_API_KEY": "cards402_...",
        "OWS_WALLET_NAME": "my-agent",
        "OWS_WALLET_PASSPHRASE": "...",
        "OWS_VAULT_PATH": "/path/to/vault"
      }
    }
  }
}
```

The `cards402` bin defaults to the `mcp` subcommand when no other
subcommand is passed, so `npx cards402` with no args boots the MCP
server. `npx cards402 mcp` is equivalent and more explicit.

Tools available: `purchase_vcc`, `setup_wallet`, `check_order`, `check_budget`.
