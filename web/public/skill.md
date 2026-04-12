# Cards402 Agent Skill

Purchase prepaid Visa virtual cards using Stellar payments, autonomously.

## Setup

When you receive a `key` and `api_url`, store them and run setup:

1. Set `CARDS402_API_KEY=<key>` in your environment
2. Set `CARDS402_API_URL=<api_url>` in your environment
3. Run wallet setup (see below)
4. Call `GET /v1/usage` to confirm connectivity

### Wallet setup

Create an OWS Stellar wallet if you don't already have one:

```typescript
import { createOWSWallet } from 'cards402';

const { publicKey } = createOWSWallet(process.env.OWS_WALLET_NAME!);
// Fund publicKey with XLM (minimum 2 XLM for fees) and USDC
```

Then register it with your key:

```typescript
import { Cards402Client } from 'cards402';

const client = new Cards402Client({
  apiKey: process.env.CARDS402_API_KEY!,
  baseUrl: process.env.CARDS402_API_URL,
});
await client.registerWallet(publicKey);
```

Your wallet address will appear in the operator dashboard.

## Buying a card (`/buy-vcc`)

```typescript
import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  baseUrl: process.env.CARDS402_API_URL,
  walletName: process.env.OWS_WALLET_NAME!,
  passphrase: process.env.OWS_WALLET_PASSPHRASE,
  amountUsdc: '10.00', // or whatever the user requested
  paymentAsset: 'usdc', // or 'xlm'
});
```

Display the result:

```
✅ Virtual Visa Card Ready

Number: XXXX XXXX XXXX XXXX
CVV:    XXX
Expiry: XX/XX
Brand:  Visa

Order: <order_id>
```

## Checking budget (`/check-vcc budget`)

```typescript
const client = new Cards402Client({ apiKey: process.env.CARDS402_API_KEY! });
const usage = await client.getUsage();
```

Display:

```
💳 Budget for <label>:
$<spent> spent of $<limit> limit — $<remaining> remaining

Orders: <total> total
  ✅ <delivered> delivered
  ❌ <failed> failed
  🔄 <refunded> refunded
```

## Environment variables

- `CARDS402_API_KEY` — your API key (required)
- `CARDS402_API_URL` — API base URL (required for self-hosted)
- `OWS_WALLET_NAME` — OWS wallet identifier (required for payments)
- `OWS_WALLET_PASSPHRASE` — wallet encryption passphrase (optional)
- `OWS_VAULT_PATH` — vault file path (optional, default: `~/.ows/vault`)
