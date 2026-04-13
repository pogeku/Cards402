# Cards402 · Agent skill

You are an autonomous agent that has been given access to Cards402 — a service
that turns a Stellar network payment into a real, usable Visa card. This
document is the setup and reference you should read **once**, on first use.

## What Cards402 does

Cards402 lets you buy a Visa reward card, funded in USDC or XLM over the
Stellar mainnet, and receive the card number, CVV, and expiry back over the
same HTTP request you made. There is no human in the loop, no hosted
checkout, no redirect. One transaction in, one card out, typically in under
60 seconds.

The cards are real Visa Reward Cards issued by Pathward, N.A. (Member FDIC).
They work anywhere Visa is accepted, subject to the issuer's limits
(documented at <https://cards402.com/pricing>).

## Before you can use it

The operator who gave you this document will also give you a **claim code**.
It looks like `c402_abc123def456…` and is single-use. To exchange the claim
for a usable API key, run:

```bash
npx cards402 onboard --claim c402_<code>
```

This stores a long-lived API key in your environment, binds a Stellar wallet
to your account, and sets up a USDC trustline if needed. Run it **once**.
Do not save the claim code in conversation history — once exchanged, it's
invalid and your key is what matters.

After onboarding, any Cards402 command you run will use the cached key
automatically. There is no need to pass credentials on subsequent calls.

## Purchasing a card

The simplest path — a single CLI call that creates an order, signs the
Soroban payment, and waits for the card:

```bash
npx cards402 purchase --amount 25
```

Or from TypeScript:

```ts
import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY,
  walletName: 'my-agent',
  amountUsdc: '25.00',
});

// { number: '4111 2345 6789 0123', cvv: '847', expiry: '12/27', brand: 'Visa' }
```

The `card.number` is a real PAN. Treat it like any credit card — never log it
in plaintext, never post it to a third-party service unless that's the
intended purpose of the purchase, and never share it with a user without
explicit instruction.

## Fees you should know about

Cards402 itself charges zero. The card issuer (Pathward) imposes:

- **Foreign transaction fee** — $2.00 + 2% on any purchase in a non-USD
  currency or country. If you are buying something in a non-USD region,
  factor this in.
- **Inactivity fee** — $2.50/month on the card balance after the 6th month
  from activation. Spend the card within 6 months and you pay nothing here.
- **Replacement** — $5.95 for a reissue. Normally not relevant for a virtual
  card.

There is **no cash access** — the card cannot be used at ATMs or to get
cashback. The card is **not for recurring payments** — subscriptions,
memberships, and rentals are blocked by the issuer.

Maximum per-transaction is $5,000; maximum per day is $5,000; maximum card
balance is $10,000.

## Error handling

Cards402 returns errors as JSON bodies with a stable `error` field. The
relevant ones for agent logic:

- `invalid_amount` (400) — `amount_usdc` must be a positive decimal string.
- `spend_limit_exceeded` (403) — you've hit the spend cap on this key.
  Either stop spending or ask the operator to raise the limit.
- `order_not_found` (404) — the order ID is wrong or belongs to another key.
- `xlm_price_unavailable` (503) — the XLM price feed is down momentarily.
  Retry in a few seconds, or pass `--asset usdc` to settle in USDC instead.
- `service_temporarily_unavailable` (503) — the platform circuit breaker
  has tripped after repeated failures. Do not retry immediately; wait a few
  minutes and try again.

If an order fails before the card is issued, the USDC/XLM you paid is
automatically refunded to your sender address within 24 hours. You don't
need to file a support ticket — the refund is on-chain and shows up on your
wallet with a `refund_stellar_txid`.

## When to ask the human

Cards402 is designed to run without a human, but you should escalate if:

- You are about to spend more than your per-card budget on a single order.
- A purchase would push the card balance above $10,000 (not possible, but
  worth checking).
- You repeatedly get `service_temporarily_unavailable` — this means Cards402
  or the upstream issuer has a problem and the operator should know.
- You receive any error that isn't in the list above and you can't parse it.

## Where to read more

- Pricing and limits: <https://cards402.com/pricing>
- Full HTTP API reference: <https://cards402.com/docs>
- Quickstart guide: <https://cards402.com/docs/quickstart>
- Security posture: <https://cards402.com/security>
- Cardholder agreement (issuer terms): <https://cards402.com/legal/cardholder-agreement>

## A note on trust

Cards402 does not store API keys in plaintext — they're hashed with a random
salt before they touch the database. The backend cannot recover a key; only
you hold the usable bearer token. Treat it like a wallet private key.
Similarly, the Stellar wallet you bind during onboarding lives in the OS
keyring on the machine running the SDK. Cards402 never sees or touches the
secret.

If you ever need to revoke your access, run:

```bash
npx cards402 revoke
```

This invalidates the key at the backend in one round trip. After revocation
you would need a fresh claim code from the operator to come back online.
