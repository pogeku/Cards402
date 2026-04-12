# cards402

Virtual Visa cards for AI agents — pay with USDC or XLM on Stellar.

[cards402.com](https://cards402.com) issues prepaid Visa virtual cards on demand. This SDK lets AI agents create orders, pay via the cards402 Soroban smart contract on Stellar, and retrieve card details programmatically.

## Installation

```bash
npm install cards402
```

## Quick start

```typescript
import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: process.env.OWS_WALLET_NAME!,
  amountUsdc: '10.00',
});

console.log(card.number, card.cvv, card.expiry);
```

## Wallet setup

Cards402 uses [OWS](https://github.com/open-wallet-standard/core) — keys are stored encrypted in a local vault file, not as plaintext env vars.

1. **Set environment variables**:
   ```
   OWS_WALLET_NAME=my-agent       # wallet identifier
   OWS_WALLET_PASSPHRASE=secret   # encryption passphrase (recommended)
   CARDS402_API_KEY=cards402_...  # from cards402.com
   ```

2. **Create and fund your wallet**:
   ```typescript
   import { createOWSWallet, addUsdcTrustlineOWS } from 'cards402';

   // Creates the wallet in ~/.ows/vault (or OWS_VAULT_PATH)
   const { publicKey } = createOWSWallet('my-agent', process.env.OWS_WALLET_PASSPHRASE);
   console.log('Fund this address:', publicKey);

   // After funding with XLM, add a USDC trustline:
   await addUsdcTrustlineOWS({ walletName: 'my-agent' });
   ```

3. **Fund the wallet**: send at least 2 XLM for account activation, then deposit USDC (if paying with USDC) from an exchange or another Stellar account.

The vault file is at `~/.ows/vault` by default. Override with `OWS_VAULT_PATH`.

---

## API reference

### `purchaseCardOWS(opts)`

All-in-one: create order, pay via Soroban contract, wait for card.

```typescript
import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: process.env.OWS_WALLET_NAME!,
  amountUsdc: '10.00',
  paymentAsset: 'usdc',       // or 'xlm' — defaults to 'usdc'
  passphrase: process.env.OWS_WALLET_PASSPHRASE,
  vaultPath: process.env.OWS_VAULT_PATH,
});

// card: { number, cvv, expiry, brand, order_id }
```

---

### OWS wallet helpers

#### `createOWSWallet(name, passphrase?, vaultPath?)`

Create a new encrypted wallet in the OWS vault.

```typescript
import { createOWSWallet } from 'cards402';

const { walletId, publicKey } = createOWSWallet('my-agent', 'passphrase');
console.log('Fund this address:', publicKey);
```

#### `importStellarKey(name, stellarSecret, passphrase?, vaultPath?)`

Migrate an existing Stellar secret key into the OWS vault.

```typescript
import { importStellarKey } from 'cards402';

const { publicKey } = importStellarKey('my-agent', 'S...existing-secret...');
```

#### `getOWSPublicKey(walletName, vaultPath?)`

Get the Stellar G-address for a named wallet.

```typescript
import { getOWSPublicKey } from 'cards402';

const publicKey = getOWSPublicKey('my-agent');
```

#### `getOWSBalance(walletName, vaultPath?)`

Check XLM and USDC balances.

```typescript
import { getOWSBalance } from 'cards402';

const { xlm, usdc } = await getOWSBalance('my-agent');
console.log(`XLM: ${xlm}, USDC: ${usdc}`);
```

#### `addUsdcTrustlineOWS(opts)`

Add a USDC trustline (required before receiving USDC).

```typescript
import { addUsdcTrustlineOWS } from 'cards402';

const txHash = await addUsdcTrustlineOWS({ walletName: 'my-agent' });
```

#### `payVCCOWS(opts)`

Pay VCC directly on Stellar using an OWS wallet. The payment instructions come from a `createOrder()` response. Called automatically by `purchaseCardOWS`.

```typescript
import { payVCCOWS } from 'cards402';

const txHash = await payVCCOWS({
  walletName: 'my-agent',
  payment: order.payment,        // from createOrder()
  paymentAsset: 'usdc',          // or 'xlm'
  passphrase: process.env.OWS_WALLET_PASSPHRASE,
});
```

---

### Raw keypair helpers

Use these if you manage Stellar keys directly (no OWS vault). For new integrations, prefer the OWS equivalents above.

#### `createWallet()`

Generate a new Stellar keypair. Store the secret key securely — it is not persisted anywhere.

```typescript
import { createWallet } from 'cards402';

const { publicKey, secret } = createWallet();
console.log('Fund this address:', publicKey);
// secret: 'S...' — keep private
```

#### `getBalance(publicKey, networkPassphrase?)`

Fetch XLM and USDC balances for any Stellar address.

```typescript
import { getBalance } from 'cards402';

const { xlm, usdc } = await getBalance('G...');
console.log(`XLM: ${xlm}, USDC: ${usdc}`);
```

#### `addUsdcTrustline(secret, networkPassphrase?)`

Add a USDC trustline using a raw Stellar secret key.

```typescript
import { addUsdcTrustline } from 'cards402';

const txHash = await addUsdcTrustline('S...your-secret...');
```

#### `payVCC(opts)`

Send a Stellar payment to VCC using a raw secret key. The payment instructions come from a `createOrder()` response.

```typescript
import { payVCC } from 'cards402';

const txHash = await payVCC({
  walletSecret: 'S...your-secret...',
  payment: order.payment,   // from createOrder()
  paymentAsset: 'usdc',     // or 'xlm'
});
```

#### `purchaseCard(opts)`

All-in-one: create order, pay VCC on Stellar, wait for card — using a raw secret key.

```typescript
import { purchaseCard } from 'cards402';

const card = await purchaseCard({
  apiKey: process.env.CARDS402_API_KEY!,
  walletSecret: process.env.STELLAR_SECRET!,
  amountUsdc: '10.00',
  paymentAsset: 'usdc',   // or 'xlm'
});

console.log(card.number, card.cvv, card.expiry);
```

---

### `Cards402Client`

The HTTP client for the cards402 API.

```typescript
import { Cards402Client } from 'cards402';

const client = new Cards402Client({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.cards402.com', // optional
});
```

#### `client.createOrder(opts)`

```typescript
const order = await client.createOrder({
  amount_usdc: '25.00',
  payment_asset: 'usdc',  // or 'xlm'
  webhook_url: 'https://yourapp.com/webhook', // optional
});

// USDC order: order.payment.contract, .usdc_contract, .amount, .order_id
// XLM order:  order.payment.contract, .xlm_sac_contract, .xlm_amount, .order_id
```

#### `client.waitForCard(orderId, options?)`

Poll until the card is delivered or the order fails. Throws typed errors on failure or timeout.

```typescript
const card = await client.waitForCard(order.order_id, {
  timeoutMs: 300000, // 5 minutes (default)
  intervalMs: 3000,  // poll every 3s (default)
});
```

#### `client.getUsage()`

```typescript
const usage = await client.getUsage();
console.log(usage.budget.spent_usdc);     // "15.00"
console.log(usage.budget.limit_usdc);     // "100.00" or null (unlimited)
console.log(usage.orders.delivered);
```

---

## Webhook verification

Every webhook from cards402 includes `X-Cards402-Signature` and `X-Cards402-Timestamp` headers.

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

function verifyWebhook(rawBody: string, signature: string, timestamp: string, secret: string): boolean {
  // Reject stale webhooks (>5 minutes)
  if (Math.abs(Date.now() - parseInt(timestamp)) > 5 * 60 * 1000) return false;
  // Signature covers "<timestamp>.<body>"
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

---

## MCP server

The cards402 MCP server exposes tools to any MCP-compatible AI client (Claude Desktop, Cursor, etc.).

### Setup

Add to your MCP client config (e.g. `~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cards402": {
      "command": "npx",
      "args": ["cards402-mcp"],
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

### Available tools

**`setup_wallet`** — Create or inspect the OWS wallet. Run this first to get your public key and funding instructions.

**`purchase_vcc`** — Buy a virtual Visa card  
Inputs: `amount_usdc` (string), `payment_asset` (`"usdc"` | `"xlm"`, optional)

**`check_order`** — Check order status  
Input: `order_id` (string)

**`check_budget`** — View spend summary and remaining budget

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CARDS402_API_KEY` | ✓ | Your cards402 API key |
| `OWS_WALLET_NAME` | ✓ | OWS wallet identifier |
| `OWS_WALLET_PASSPHRASE` | — | Wallet encryption passphrase |
| `OWS_VAULT_PATH` | — | Vault file path (default: `~/.ows/vault`) |
| `CARDS402_BASE_URL` | — | Override the API base URL |

---

## Claude Code skills

Two slash commands are included in `skill/`:

```bash
cp node_modules/cards402/skill/buy-vcc.md ~/.claude/commands/buy-vcc.md
cp node_modules/cards402/skill/check-vcc.md ~/.claude/commands/check-vcc.md
```

Then in Claude Code:
```
/buy-vcc 25
/check-vcc order_abc123
```

Required env vars: `CARDS402_API_KEY`, `OWS_WALLET_NAME`, `OWS_WALLET_PASSPHRASE` (optional).

## License

MIT
