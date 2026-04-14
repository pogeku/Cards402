# Cards402

Virtual cards for AI agents. Pay USDC or XLM on Stellar, get a Visa card number in ~60 seconds. No fees.

API: `https://api.cards402.com`  
Web: `https://cards402.com`

---

## Repository structure

```
cards402/
├── contract/       Soroban smart contract (Rust, open source)
├── sdk/            TypeScript client + MCP server (open source)
└── web/            Next.js marketing site + docs (open source)
```

The agent-facing pieces — the receiver contract, the TypeScript SDK, and the
marketing + dashboard web app — are open source and live in this repository. The
fulfillment engine that turns confirmed on-chain payments into Visa cards
(`backend/`) is closed source and not published here; it talks to a separate
VCC service over HTTP + HMAC webhooks. If you're running the backend
yourself, its `.env.example` and internal docs ship with the private repo.

---

## Components

### `sdk/` — TypeScript SDK

Agent-facing client library and MCP server.

```bash
cd sdk
npm install
npm run build
```

Exports `Cards402Client` (HTTP wrapper), `payViaContract` / `payViaContractOWS`
(Soroban contract invocation using a raw keypair or an OWS-custody wallet),
`purchaseCard` / `purchaseCardOWS` (create → pay → wait all-in-one), and an
MCP server usable with Claude Desktop or any MCP host. Published to npm as
`cards402`.

### `web/` — Marketing site

Next.js app serving the landing page, docs, and agent portal.

```bash
cd web
npm install
npm run dev       # http://localhost:3000
npm run build     # production build
```

Requires `NEXT_PUBLIC_API_BASE_URL` — see `web/.env.production`.

### `contract/` — Soroban smart contract

Rust contract deployed on Stellar mainnet. Receives USDC or XLM and emits a payment event that the backend watches.

```bash
cd contract
cargo build --target wasm32-unknown-unknown --release
```

Contract ID: set in `RECEIVER_CONTRACT_ID` env var on the backend.

---

## Quick start (agents)

See the [quickstart](https://cards402.com/docs/quickstart), the full [API reference](https://cards402.com/docs), or the [skill.md](https://cards402.com/skill.md) drop-in agent instructions.

1. Get an API key (contact us or use the portal)
2. Create an order — you get a contract address and expected amount
3. Pay via Stellar (USDC or XLM)
4. Poll `GET /v1/orders/:id` until `phase === "ready"`
5. Card details are in the response

Or use the SDK:

```typescript
import { Cards402Client, payViaContract } from 'cards402';

const client = new Cards402Client({ apiKey: 'cards402_...' });
const order = await client.createOrder({ amount_usdc: '10.00' });
await payViaContract({ walletSecret: process.env.STELLAR_SECRET!, payment: order.payment });
const card = await client.waitForCard(order.order_id);
```

For agents using an OWS-custody wallet, replace `payViaContract` with
`payViaContractOWS` and pass `{ walletName, passphrase }` instead of
`walletSecret`, or use `purchaseCardOWS` to do the whole flow in one call.

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design: fulfillment pipeline, Soroban event watcher, CTX integration, scraper stages, security model, and API reference.

---

## Development

This repo uses [Husky](https://typicode.github.io/husky/) pre-commit hooks and [lint-staged](https://github.com/okonet/lint-staged) for linting. Commitlint enforces conventional commits.

```bash
npm install        # installs root dev tooling (husky, lint-staged, commitlint)
```

Each subdirectory has its own `package.json` and must be set up independently.
