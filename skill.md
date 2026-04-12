# cards402 — Virtual Visa Cards for AI Agents

Purchase prepaid Visa virtual cards by paying with XLM or USDC on Stellar.
Cards are delivered in 30–60 seconds.

## Setup

Your operator gives you:
- **key** — your API key (starts with `cards402_`)
- **api_url** — e.g. `https://api.cards402.com/v1`

### 1. Install OWS (one-time)

```bash
curl -fsSL https://cards402.com/install-ows.sh | bash
```

This installs the Open Wallet Standard CLI + Node bindings with Stellar support.

### 2. Create your wallet

```bash
ows create-wallet my-agent
```

This creates an encrypted wallet on your machine. Get your Stellar address:

```bash
ows get-wallet my-agent | grep stellar
```

**Tell your operator:** "Please send at least 3 XLM to `<your G... address>`"

Wait for them to confirm funding, then verify:

```bash
ows get-balance my-agent stellar
```

### 3. Buy a card

```bash
cd /path/to/cards402/sdk

export CARDS402_API_KEY="<your key>"
export CARDS402_API_URL="<your api url>"

node -e "
const { purchaseCardOWS } = require('./dist/ows');
purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY,
  baseUrl: process.env.CARDS402_API_URL,
  walletName: 'my-agent',
  amountUsdc: '10.00',
  paymentAsset: 'xlm',
}).then(r => {
  console.log('Card:', r.number);
  console.log('CVV:', r.cvv);
  console.log('Expiry:', r.expiry);
}).catch(e => console.error(e.message));
"
```

## Quick reference

### Check balance
```bash
ows get-balance my-agent stellar
```

### Check budget
```bash
curl -s $CARDS402_API_URL/usage -H "X-Api-Key: $CARDS402_API_KEY"
```

### Check order status
```bash
curl -s $CARDS402_API_URL/orders/$ORDER_ID -H "X-Api-Key: $CARDS402_API_KEY"
```

When `phase` is `ready`, the `card` object has `number`, `cvv`, `expiry`.

## Errors

| Error | What to do |
|---|---|
| `insufficient_balance` | Ask operator for more XLM |
| `spend_limit_exceeded` | Hit your daily/total budget |
| `policy_requires_approval` | Operator must approve this amount |
| `service_temporarily_unavailable` | Retry in a minute |
| `rate_limit_exceeded` | Back off and retry |

## Alternative: raw keypair (no OWS)

If you manage your own Stellar secret key instead of OWS:

```bash
node -e "
const { purchaseCard } = require('./dist/stellar');
purchaseCard({
  apiKey: process.env.CARDS402_API_KEY,
  walletSecret: process.env.STELLAR_WALLET_SECRET,
  baseUrl: process.env.CARDS402_API_URL,
  amountUsdc: '10.00',
  paymentAsset: 'xlm',
}).then(r => console.log('Card:', r.number, 'CVV:', r.cvv, 'Exp:', r.expiry));
"
```
