# Cards402

Virtual cards for AI agents. Pay USDC or XLM on Stellar, get a Visa card number in ~33 seconds.

API: `https://api.cards402.com`
Web: `https://cards402.com`

---

## Repository structure

```
cards402/
├── backend/        Node.js/Express API, Soroban watcher, SQLite, policy engine
├── contract/       Soroban smart contract (Rust)
├── sdk/            TypeScript client + CLI + MCP server (npm: cards402)
├── web/            Next.js marketing site, docs, operator dashboard
├── docs/           Published API guide (skill.md, llms.txt)
├── examples/       Integration examples
└── scripts/        Deploy and ops tooling
```

Everything is open source. The backend, SDK, contract, web app, and operator
dashboard all live in this repo. The fulfillment engine that scrapes upstream
gift-card providers (`vcc/`) is a separate private service — it talks to the
backend over HTTP + HMAC webhooks.

---

## Components

### `backend/` — API server

Node.js/Express backend. Soroban event watcher, order state machine, policy
engine (spend limits, approval flows, time windows), agent auth (API keys with
bcrypt + prefix index), operator dashboard API, webhook delivery with
per-origin circuit breakers, and background jobs (reconciliation, expiry,
pruning).

```bash
cd backend
npm install
cp .env.example .env     # fill in Stellar keys, VCC config, SMTP
npm run dev              # http://localhost:4000
npm test                 # 1,038 tests
```

SQLite (WAL mode, better-sqlite3). Migrations run automatically on startup.

### `sdk/` — TypeScript SDK + CLI + MCP server

Agent-facing client library. Exports `Cards402Client` (HTTP wrapper),
`payViaContract` / `payViaContractOWS` (Soroban contract invocation),
`purchaseCard` / `purchaseCardOWS` (create → pay → wait all-in-one), and an
MCP server for Claude Desktop or any MCP host.

```bash
cd sdk
npm install
npm run build
```

CLI commands: `cards402 onboard`, `cards402 purchase`, `cards402 wallet`,
`cards402 mcp`. Published to npm as [`cards402`](https://www.npmjs.com/package/cards402).

### `web/` — Marketing site + operator dashboard

Next.js app serving the landing page, docs, blog, changelog, and the
full operator dashboard (agents, orders, approvals, alerts, treasury,
margins, webhooks, audit log).

```bash
cd web
npm install
npm run dev              # http://localhost:3000
npm run build
```

### `contract/` — Soroban smart contract

Rust contract deployed on Stellar mainnet. Receives USDC or XLM from agents
and emits a payment event that the backend watcher indexes.

```bash
cd contract
cargo build --target wasm32-unknown-unknown --release
```

Contract ID is set via `RECEIVER_CONTRACT_ID` in the backend env.

---

## Quick start (agents)

See the [quickstart](https://cards402.com/docs/quickstart), the full
[API reference](https://cards402.com/docs), or the
[skill.md](https://cards402.com/skill.md) drop-in agent instructions.

1. Ask your operator to create an agent in the dashboard — they'll give you a claim code
2. `npx -y cards402@latest onboard --claim <code>` — exchanges the claim code for credentials
3. Fund the wallet with XLM (or USDC after opening a trustline)
4. `npx -y cards402@latest purchase --amount 10` — buys a $10 Visa card

Or use the SDK programmatically:

```typescript
import { purchaseCardOWS } from 'cards402';

const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: 'my-agent',
  amountUsdc: '10.00',
  paymentAsset: 'usdc',
});
// card = { number, cvv, expiry, brand, order_id }
```

For raw-keypair wallets (no OWS), use `payViaContract` + `Cards402Client`:

```typescript
import { Cards402Client, payViaContract } from 'cards402';

const client = new Cards402Client({ apiKey: 'cards402_...' });
const order = await client.createOrder({ amount_usdc: '10.00' });
await payViaContract({ walletSecret: process.env.STELLAR_SECRET!, payment: order.payment });
const card = await client.waitForCard(order.order_id);
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design:
fulfillment pipeline, Soroban event watcher, CTX integration, security model,
and API reference.

---

## Development

This repo uses npm workspaces, [Husky](https://typicode.github.io/husky/)
pre-commit hooks, and [lint-staged](https://github.com/okonet/lint-staged)
for formatting. [Commitlint](https://commitlint.js.org/) enforces
conventional commits. Allowed scopes: `backend`, `web`, `sdk`, `infra`,
`deps`, `ci`.

```bash
npm install              # root dev tooling (husky, lint-staged, commitlint)
cd backend && npm install
cd web && npm install
cd sdk && npm install
```

CI runs typecheck, lint, tests (backend 1,038 + web 57 + SDK 114), Semgrep
SAST, gitleaks secret scan, and Playwright E2E on every push and PR.
