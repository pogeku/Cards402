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

### 2. Create your wallet

```bash
ows wallet create --name my-agent
```

Find your Stellar address in the output — the line starting `stellar:pubnet →`.

**Tell your operator:** "Please send at least 3 XLM to `G...`" (your stellar address).

### 3. Buy a card

Once funded, install the SDK and buy:

```bash
npm install cards402
```

```javascript
const { purchaseCardOWS } = require('cards402/ows');

const card = await purchaseCardOWS({
  apiKey: '<your key>',
  baseUrl: '<your api_url>',
  walletName: 'my-agent',
  amountUsdc: '10.00',
  paymentAsset: 'xlm',
});

console.log('Card:', card.number, 'CVV:', card.cvv, 'Exp:', card.expiry);
```

## Quick reference

| Action | Command |
|---|---|
| Check wallet balance | `ows wallet get --name my-agent` |
| Check spend budget | `curl $API_URL/usage -H "X-Api-Key: $KEY"` |
| Check order status | `curl $API_URL/orders/$ID -H "X-Api-Key: $KEY"` |
| List recent orders | `curl $API_URL/orders -H "X-Api-Key: $KEY"` |

## Errors

| Error | What to do |
|---|---|
| `insufficient_balance` | Ask operator for more XLM |
| `spend_limit_exceeded` | Hit your daily/total budget |
| `policy_requires_approval` | Operator must approve this amount |
| `service_temporarily_unavailable` | Retry in a minute |

## Timing

Order → payment → card: **30–60 seconds**
