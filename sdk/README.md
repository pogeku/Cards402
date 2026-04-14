# cards402

Virtual Visa cards for AI agents — pay with USDC or XLM on Stellar, get a card number, CVV, and expiry in ~60 seconds.

[cards402.com](https://cards402.com) issues prepaid Visa virtual cards on demand. This SDK lets AI agents create an order, pay the cards402 Soroban receiver contract on Stellar, and receive card details programmatically — all in one call.

## Install

```bash
npm install cards402
```

Requires Node.js 18 or newer (the SDK uses native `fetch`, `ReadableStream`, and `WebCrypto`). Supported platforms via the bundled `@ctx.com/stellar-ows-core` native wallet bindings: macOS (arm64 + x64), Linux (arm64 + x64). Windows is not currently supported.

### A note on `npm audit`

You'll see 3 critical advisories on `axios <= 1.14.0` after installing. They come from `@stellar/stellar-sdk`, which hard-pins an older axios version that we can't override from inside this package. The SDK's own HTTP calls only talk to hardcoded Stellar RPC / Horizon endpoints, so neither advisory (NO_PROXY SSRF, header-injection metadata exfil) is reachable through cards402 code — it's noise for our use, but noise you should still silence at your own project root.

Fix in your own `package.json`:

```json
{
  "overrides": {
    "axios": "^1.15.0"
  }
}
```

then `rm -rf node_modules package-lock.json && npm install`. `npm audit` returns clean. Upstream fix tracked at [stellar/js-stellar-sdk#1381](https://github.com/stellar/js-stellar-sdk/pull/1381); this note will be removed as soon as it merges and a new stellar-sdk ships.

## Quick start

```typescript
import { createOWSWallet, getOWSBalance, purchaseCardOWS } from 'cards402';

// 1. Create (or fetch existing) encrypted wallet. Idempotent.
const { publicKey } = createOWSWallet('my-agent');
console.log('Fund this Stellar address:', publicKey);

// 2. Pause here until the address has funds. Re-run to check:
const bal = await getOWSBalance('my-agent');
console.log(`XLM: ${bal.xlm}  USDC: ${bal.usdc}`);

// 3. Purchase a card — only do this when the user explicitly asks.
const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: 'my-agent',
  amountUsdc: '10.00',
  paymentAsset: 'xlm', // or 'usdc' (trustline added automatically)
});

console.log(card.number, card.cvv, card.expiry);
```

`purchaseCardOWS` handles the whole flow:

1. `POST /v1/orders` with the amount
2. Sign + submit the Soroban payment from your OWS wallet
3. Subscribe to the SSE stream at `/v1/orders/:id/stream`
4. Return the card details as soon as the `ready` event arrives

No polling loops, no webhook endpoint required.

## Funding your wallet

Stellar accounts need a minimum balance to be activated on-chain:

- **Pay with XLM:** send ≥ 1 XLM to cover the base reserve, plus whatever XLM the card costs at the current spot rate (shown in `payment.xlm.amount` when you create an order).
- **Pay with USDC:** send ≥ 2 XLM (1 base reserve + 1 for the USDC trustline entry), plus the USDC card amount. The SDK will add the trustline automatically the first time you purchase with USDC, so you just need the ≥ 2 XLM on-chain before calling `purchaseCardOWS`.

## Step-by-step API (for more control)

```typescript
import { Cards402Client } from 'cards402';

const client = new Cards402Client({
  apiKey: process.env.CARDS402_API_KEY!,
  // baseUrl defaults to https://api.cards402.com/v1
});

// Create the order
const order = await client.createOrder({ amount_usdc: '10.00' });
console.log(`Pay ${order.payment.xlm.amount} XLM to contract ${order.payment.contract_id}`);

// ... submit the Soroban transaction yourself, or use the payViaContract helpers ...

// Wait for delivery (uses SSE under the hood, with polling fallback)
const card = await client.waitForCard(order.order_id, { timeoutMs: 120000 });
console.log(card.number, card.cvv, card.expiry);
```

## MCP server — for Claude Desktop, Cursor, and other MCP clients

Add to your client's `mcpServers` config:

```json
{
  "mcpServers": {
    "cards402": {
      "command": "npx",
      "args": ["-y", "cards402"],
      "env": { "CARDS402_API_KEY": "cards402_<your key>" }
    }
  }
}
```

The MCP server exposes four tools: `setup_wallet`, `check_budget`, `check_order`, and `purchase_vcc`.

## Error handling

All SDK errors inherit from `Cards402Error`. Typed subclasses let you react to specific failure modes:

```typescript
import {
  Cards402Error,
  AuthError,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  InvalidAmountError,
  OrderFailedError,
  WaitTimeoutError,
} from 'cards402';

try {
  const card = await purchaseCardOWS({ ... });
} catch (err) {
  if (err instanceof SpendLimitError) { /* cap reached — ask owner to raise */ }
  else if (err instanceof OrderFailedError) { /* check err.refund for refund tx */ }
  else if (err instanceof WaitTimeoutError) { /* network flake or stalled fulfillment */ }
  else if (err instanceof AuthError) { /* bad key */ }
}
```

## Keeping card details safe

`purchaseCardOWS` returns the card PAN, CVV, and expiry as plain strings. **Treat them as secrets.** Don't log them, don't write them to disk, don't send them to observability pipelines unless those pipelines are explicitly PCI-compliant.

## Links

- [cards402.com](https://cards402.com) — dashboard and docs
- [cards402.com/docs](https://cards402.com/docs) — full API reference
- [cards402.com/skill.md](https://cards402.com/skill.md) — drop-in agent onboarding brief
- [cards402.com/llms.txt](https://cards402.com/llms.txt) — LLM-index of every docs surface
- [github.com/CTX-com/Cards402](https://github.com/CTX-com/Cards402) — source

## License

MIT — see [LICENSE](./LICENSE).
