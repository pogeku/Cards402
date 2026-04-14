# cards402 Architecture

## Overview

cards402 is an agentic virtual-card service. AI agents pay USDC or XLM to a
Soroban receiver contract on Stellar; cards402 detects the on-chain payment,
orchestrates card procurement through a separate fulfillment service
(**vcc**), and returns the Visa prepaid card details (PAN, CVV, expiry) to
the agent. No fees. 1:1 USDC → card value.

The system is **two cooperating services plus an open-source SDK**:

| Component                                           | Repo / Directory                         | Role                                                                                              |
| --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **cards402 backend** (closed source)                | `backend/` in this repo — ignored by git | Agent-facing HTTP API, Soroban event watcher, order state machine, admin/dashboard, policy engine |
| **cards402 web** (open source)                      | `web/`                                   | Marketing site, docs, admin dashboard                                                             |
| **cards402 SDK** (open source)                      | `sdk/`                                   | TypeScript client, OWS-wallet helpers, MCP server                                                 |
| **cards402 contract** (open source)                 | `contract/`                              | Soroban receiver contract (Rust) — agents pay this                                                |
| **vcc api** (separate repo at `~/code/vcc/api`)     | —                                        | Fulfillment engine: CTX gift-card ordering + claim scraping + HMAC callback to cards402           |
| **vcc admin** (separate repo at `~/code/vcc/admin`) | —                                        | Ops dashboard for vcc                                                                             |

---

## Repository layout (this repo)

```
cards402/
├── ARCHITECTURE.md          ← this file
├── AGENTS.md                ← agent-facing API guide (published)
├── README.md                ← developer quick start
├── contract/                ← Soroban receiver contract (Rust, open source)
│   ├── src/lib.rs             pay_usdc / pay_xlm / upgrade / init
│   └── Cargo.toml
├── sdk/                     ← TypeScript client + MCP server (open source)
│   ├── src/
│   │   ├── client.ts          Cards402Client HTTP wrapper
│   │   ├── soroban.ts         shared contract-call helpers (simulate, assemble, submit)
│   │   ├── stellar.ts         raw-keypair payViaContract / purchaseCard
│   │   ├── ows.ts             OWS-wallet payViaContractOWS / purchaseCardOWS
│   │   ├── errors.ts          typed error taxonomy
│   │   └── mcp.ts             MCP server (purchase_vcc, check_order, …)
│   └── src/__tests__/
├── web/                     ← Next.js marketing + admin dashboard (open source)
│   ├── app/page.tsx           landing page
│   ├── app/docs/              public API docs
│   ├── app/admin/             operator dashboard
│   ├── app/dashboard/         per-tenant dashboard
│   └── middleware.ts
└── backend/                 ← closed source, not committed
    └── src/
        ├── index.js             entry point — boots Soroban watcher + jobs + Express
        ├── app.js               Express app, CORS, rate limiting, route mounting
        ├── env.js               zod env validation (fail-fast)
        ├── db.js                SQLite schema + migrations
        ├── jobs.js              background reconcilers (expiry, stuck-ordering, webhooks)
        ├── fulfillment.js       enqueueWebhook, scheduleRefund, freeze helpers
        ├── policy.js            spend-control rules + approval gating
        ├── vcc-client.js        HTTP client for the vcc api (register, invoice, paid, status)
        ├── api/
        │   ├── orders.js        POST/GET /v1/orders
        │   ├── admin.js         /admin/* (owner-scoped)
        │   ├── dashboard.js     /dashboard/* (per-user tenant)
        │   ├── auth.js          OTP email login, session issuance
        │   └── vcc-callback.js  HMAC-verified webhook from vcc on fulfillment result
        ├── payments/
        │   ├── stellar.js       Soroban event watcher (persistent cursor)
        │   ├── xlm-sender.js    XLM treasury payments (to CTX via vcc-supplied URI)
        │   └── xlm-price.js     CTX XLM/USD rate quote
        ├── middleware/          auth.js, requireAuth, requireDashboard, requireOwner, requireInternal
        └── lib/                 ssrf.js, retry.js, logger.js, email.js
```

---

## End-to-end payment flow

```
┌───────┐      ┌───────────┐   ┌────────────────┐   ┌──────────┐   ┌─────────┐
│ Agent │─(1)─▶│ cards402  │─(2)─▶│ Soroban        │─(3)─▶│ cards402│─(4)─▶│   vcc   │
│  SDK  │      │ backend   │   │ receiver       │   │ watcher  │   │  api    │
└───────┘      │  /v1      │   │ contract       │   │          │   │         │
    ▲          └───────────┘   └────────────────┘   └────┬─────┘   └────┬────┘
    │                                                    │              │
    │                                                    │              │ (5) fetch
    │ (8) poll /v1/orders/:id                            │              ▼
    │     → phase = ready + card                         │         ┌────────┐
    │                                                    │         │ CTX.com│
    │                                                    │         │ gift   │
    │                                                    │         │ cards  │
    │                                                    │         └───┬────┘
    │                                                    │             │ (6) claim URL
    │ (7b) HMAC-signed callback                          │             ▼
    └───────────────────────────────────────────────┐   │        (7a) vcc scrapes
                                                    │   │             claim.storedvalue.com
                                                    │   │             → yourrewardcard.com
                                                    │   │             → PAN/CVV/expiry
                                                    │   │
              POST /vcc-callback { order_id,       │   │
                card: { number, cvv, expiry } }    │   │
              (HMAC sha256=hmac(secret, ts.body))  │   │
```

### Steps

1. **Agent creates an order.** `POST /v1/orders` with `{ amount_usdc, webhook_url?, metadata? }` and an `Idempotency-Key` header. Note: asset choice happens at _payment_ time, not creation time — the response includes both a USDC quote and an XLM quote, and the agent picks which one to pay by calling `pay_usdc` or `pay_xlm` on the receiver contract. cards402 validates the request, evaluates the policy engine, and either:
   - returns a Soroban `contractPayment` response `{ type: 'soroban_contract', contract_id, order_id, usdc, xlm }` and an order in `pending_payment`; or
   - returns 202 with `phase: 'awaiting_approval'` and creates an approval request for the dashboard owner to decide within 2 hours.
2. **Agent pays the contract.** Using the SDK's `payViaContract` / `payViaContractOWS`, the agent builds a Soroban transaction invoking `pay_usdc(from, amount_i128, order_id_bytes)` (or `pay_xlm`) on the receiver contract, signs, simulates, assembles, and submits via RPC. `order_id` is UTF-8 bytes of the order UUID.
3. **Contract transfers USDC/XLM to treasury** and emits a `payment` event: `topics = [Symbol("pay_usdc"|"pay_xlm"), order_id_bytes, from_address], value = amount_i128`.
4. **Soroban watcher picks up the event** (`backend/src/payments/stellar.js`). It polls `rpc.Server.getEvents()` every 5 seconds filtered to the receiver contract, persists the `stellar_start_ledger` cursor in `system_state` across restarts, and calls `handlePayment({ txid, paymentAsset, amountUsdc, amountXlm, senderAddress, orderId })` for each matching event.
5. **cards402 hands the order to vcc.** `handlePayment` atomically CASes the order from `pending_payment` → `ordering` and then invokes `vcc-client.js getInvoice(orderId, amount_usdc)`, which POSTs `/api/jobs/invoice` on the vcc api. vcc contacts CTX.com, gets a gift-card order with an XLM `payment_url` (a `web+stellar:pay` URI), and returns `{ job_id, payment_url }`.
6. **cards402 pays CTX.** `payments/xlm-sender.js payCtxOrder(payment_url)` parses the SEP-0007 URI and sends the required XLM from treasury. Then cards402 calls `POST /api/jobs/:job_id/paid` on vcc (`notifyPaid`).
7. **vcc fulfills.** vcc polls CTX for the claim URL, runs stage1/stage2 scrapers (Playwright + CAPTCHA solver) to extract PAN/CVV/expiry, then HMAC-signs a callback to `POST /vcc-callback` on cards402 with the card details (header `X-VCC-Signature: sha256=<hmac("<timestamp>.<body>", callback_secret)>`).
8. **cards402 delivers to the agent.** `api/vcc-callback.js` verifies the HMAC + 5-minute timestamp window, transitions the order to `delivered`, fires an optional agent webhook, and increments per-key spend. The next poll of `GET /v1/orders/:id` returns `phase: 'ready'` with the card.

### Crash-recovery semantics

Each step between the atomic CAS and the vcc callback is recoverable by the reconciler in `jobs.js`:

| Checkpoint          | Column set            | If crash  | Reconciler action                                                                                                                                                              |
| ------------------- | --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CAS → `ordering`    | `status = 'ordering'` | —         | (not stuck)                                                                                                                                                                    |
| After `getInvoice`  | `vcc_job_id`          | next tick | retry `getInvoice` (vcc UNIQUE(tenant_id, order_id) is idempotent)                                                                                                             |
| After `payCtxOrder` | `xlm_sent_at`         | next tick | retry `payCtxOrder` — gated by `xlm_sent_at IS NULL` to prevent double-pay; if vcc reports the job has moved past `invoice_issued`, assume the payment already landed and skip |
| After `notifyPaid`  | `vcc_notified_at`     | next tick | retry `notifyPaid` — vcc returns `{note: 'already_queued'}` if already past that state                                                                                         |

After `STUCK_RETRY_AFTER_MS = 2 min` of inactivity the reconciler retries the next unfinished step. After `STUCK_FAIL_AFTER_MS = 10 min` or `MAX_FULFILLMENT_ATTEMPTS = 3` retries without progress, the order is hard-failed and a refund is queued via `scheduleRefund`.

### Failure modes

- **Any fulfillment step throws** → order moves to `failed`, `error` is recorded, `scheduleRefund(orderId)` queues a refund to `sender_address` in the same asset the agent paid with (USDC if `payment_asset = 'usdc_soroban'`, XLM if `'xlm_soroban'`). The refund txid is stored in `refund_stellar_txid` in the DB (the original payment txid stays in `stellar_txid`) and exposed to agents on `GET /v1/orders/:id` as `refund.stellar_txid` (nested object).
- **3 consecutive failures** → system freezes. `/v1/orders` returns 503. Owner unfreezes via `POST /admin/system/unfreeze`.
- **Payment never arrives** → the order expires after 2 hours (`expireStaleOrders` in `jobs.js`) and moves to `expired`; no funds were taken.
- **Approval times out** → `expireApprovalRequests` moves the approval to `expired` and the order to `rejected` after 2 hours.
- **Unmatched payment** (payment event whose `order_id` doesn't exist, or for a non-`pending_payment` order) → row written to `unmatched_payments` for manual or automated refund.

---

## Soroban receiver contract

Location: `contract/src/lib.rs`. Published to mainnet; the contract ID lives in `RECEIVER_CONTRACT_ID`.

```rust
pub fn pay_usdc(env: Env, from: Address, amount: i128, order_id: Bytes) {
    if amount <= 0 { panic!("amount must be positive"); }
    from.require_auth();
    let treasury = env.storage().instance().get(&DataKey::Treasury).unwrap();
    let usdc     = env.storage().instance().get(&DataKey::UsdcContract).unwrap();
    token::Client::new(&env, &usdc).transfer(&from, &treasury, &amount);
    env.events().publish((Symbol::new(&env, "pay_usdc"), order_id, from), amount);
    env.storage().instance().extend_ttl(17_280_000, 17_280_000);
}
```

- `pay_xlm` is the same shape against the native XLM SAC.
- `from.require_auth()` means the agent's wallet must sign the transaction.
- **Not immutable** — `upgrade(new_wasm_hash)` is admin-gated. Burn the admin key if you want full immutability. See `contract/README.md`.

Contract tests in `contract/src/lib.rs` cover: init idempotence, auth requirements on every entrypoint, correct event shape for both `pay_usdc` and `pay_xlm`, zero/negative amount rejection, uninitialized-state error paths, and upgrade auth. 16 tests, all passing under `cargo test`.

`soroban-sdk` is pinned to `=22.0.11` so audited WASM matches rebuilt WASM.

---

## Agent API (`/v1`)

Base URL: `https://api.cards402.com`. Auth: `X-Api-Key: cards402_<key>` on every request.

| Endpoint             | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `GET /status`        | Health check + circuit-breaker state (`frozen`, `consecutive_failures`) |
| `POST /v1/orders`    | Create order, get Soroban `payment` instructions                        |
| `GET /v1/orders/:id` | Poll order status, get card when `phase == "ready"`                     |
| `GET /v1/orders`     | List this key's recent orders                                           |
| `GET /v1/usage`      | Spend summary + budget                                                  |

Stable **phases** that agents watch (`sdk/src/client.ts` `OrderPhase`):

```
awaiting_approval → awaiting_payment → processing → ready
      ↓ rejected              ↓ expired    ↓ failed → refunded
```

Internal **status** values (more granular, only used internally and in admin): `pending_payment → ordering → delivered | failed | refund_pending | refunded | expired | rejected | awaiting_approval`. The phase mapping lives at `backend/src/api/orders.js:297`.

See `AGENTS.md` for the full published API reference + idempotency + webhook + error-code docs.

---

## Admin & dashboard

Two layers, both sessioned via email OTP (`POST /auth/login` → `POST /auth/verify` → Bearer token):

- **Owner admin** (`/admin/*`): full system visibility — all orders, api keys, approval decisions, system unfreeze, manual refunds. Route guard: `requireAuth + requireOwner`.
- **Per-user dashboard** (`/dashboard/*`): scoped to a single `dashboards` row. Each user gets their own dashboard with their own api keys and orders. Route guard: `requireAuth + requireDashboard`.

Approval flow (`backend/src/api/dashboard.js` and `api/admin.js`): when policy returns `pending_approval`, the order is created in `awaiting_approval` status with an `approval_requests` row. Owner approves → orders moves to `pending_payment` with the same `contractPayment` shape as a normal order; reject → order moves to `rejected`; timeout → `expireApprovalRequests` in `jobs.js` moves it to `rejected` with the reason `approval_expired`.

---

## Interface with vcc

cards402 talks to vcc exclusively over HTTP. The contract is defined in `backend/src/vcc-client.js` and implemented on the vcc side under `~/code/vcc/api/src/api/`.

| Method      | Endpoint             | Purpose                                                                                                                    |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST`      | `/api/register`      | First boot — self-register, get a bearer token encrypted at rest (`VCC_TOKEN_KEY`)                                         |
| `POST`      | `/api/jobs/invoice`  | `{order_id, amount_usdc, callback_url, callback_secret}` → `{job_id, payment_url}`. Idempotent on `(tenant_id, order_id)`. |
| `POST`      | `/api/jobs/:id/paid` | Notify that cards402 has sent XLM to CTX — vcc starts scraping                                                             |
| `GET`       | `/api/jobs/:id`      | Poll job status (fallback when the callback is lost)                                                                       |
| — (inbound) | `POST /vcc-callback` | vcc's HMAC-signed result callback to cards402                                                                              |

### Callback signature

vcc signs `"<timestamp>.<order_id>.<rawBody>"` with HMAC-SHA256 using `callback_secret` (the one cards402 supplied at invoice creation). Headers: `X-VCC-Signature: sha256=<hex>`, `X-VCC-Timestamp: <unix-ms>`, `X-VCC-Order-Id: <uuid>`. cards402 rejects any callback whose timestamp is more than 10 minutes old, validates the HMAC with a timing-safe hex compare, and refuses any request where the header `X-VCC-Order-Id` does not match the body's `order_id` field (defence against cross-order replay). The shared signer/verifier lives in `backend/src/lib/hmac.js` (mirrored at `vcc/api/src/lib/hmac.js`); callers are `vcc/api/src/fulfillment.js notifyCards402` and `backend/src/api/vcc-callback.js`. Legacy v1 signatures (format `"<timestamp>.<rawBody>"`, no `order_id`) are still accepted during the rollout and will be removed once both services are known to be on v2.

### At-rest encryption

vcc stores PAN, CVV, expiry, and `callback_secret` encrypted with AES-256-GCM under `VCC_DATA_KEY` (32-byte hex). Required in production; dev fallback is plaintext with a warning. `lib/crypto.js encrypt/decrypt/maskPan`.

### Concurrency cap

vcc bounds in-flight fulfillment jobs at `VCC_MAX_CONCURRENT_JOBS` (default 3) so a burst of queued jobs can't spin up unbounded Chromium contexts. Implemented with a simple semaphore in `fulfillment.js` around `runJob`.

---

## Security model

- **API keys** — bcrypt-hashed; raw key shown once at creation. Fast-path lookup via a `key_prefix` index before bcrypt.
- **Admin sessions** — email OTP → Bearer token, 7-day TTL. All state-changing admin calls are gated by `requireAuth + requireOwner`. The web dashboard cookie is HttpOnly and signed with an HMAC session token (not the raw Bearer).
- **Webhook secrets** — per-api-key HMAC-SHA256, canonical signed string is `"<timestamp>.<body>"`. Retry queue in `webhook_queue` with 3 attempts at 30s/5m/30m; consumers must be idempotent.
- **SSRF protection** — webhook and vcc callback URLs are validated via DNS lookup + private-IP blocklist at both creation and fire time. `lib/ssrf.js`.
- **Rate limits** — 60 orders/hr/key on `/v1/orders`; 600 polls/min/key on `/v1/orders/:id`; 100 admin req/15min by IP.
- **Spend limits** — enforced per api key against settled spend + in-flight orders before accepting a new request. Auto-freeze after 3 consecutive fulfillment failures.
- **Refund queue** — `jobs.js reconcileOrderingFulfillment` hard-fails and queues refunds for orders that exhaust `MAX_FULFILLMENT_ATTEMPTS = 3` retries or exceed `STUCK_FAIL_AFTER_MS = 10min`.

---

## Environment variables (backend)

See `backend/.env.example` for the full list with comments. Critical ones:

| Variable               | Required | Purpose                                                   |
| ---------------------- | -------- | --------------------------------------------------------- |
| `STELLAR_XLM_SECRET`   | ✓        | Treasury wallet — pays CTX in XLM, sends USDC refunds     |
| `RECEIVER_CONTRACT_ID` | ✓        | Deployed Soroban receiver contract                        |
| `SOROBAN_RPC_URL`      | —        | Defaults to public mainnet/testnet                        |
| `VCC_API_BASE`         | ✓        | vcc api URL (e.g. `https://vcc.ctx.com`)                  |
| `CARDS402_BASE_URL`    | ✓        | Public base URL — vcc uses this to build the callback URL |
| `VCC_CALLBACK_SECRET`  | ✓        | HMAC secret for `/vcc-callback` — ≥16 chars               |
| `VCC_TOKEN_KEY`        | —        | 32-byte hex key encrypting vcc bearer token at rest       |
| `STELLAR_USDC_ISSUER`  | —        | USDC classic asset issuer (mainnet default)               |
| `OWNER_EMAIL`          | —        | Locks the owner role to this email on first boot          |
| `CORS_ORIGINS`         | —        | Comma-separated allowed origins                           |
| `INTERNAL_EMAILS`      | —        | Comma-separated emails allowed on `/internal/*`           |

---

## Where to look when something breaks

- Soroban event watcher silent → `backend/src/payments/stellar.js` (check `stellar_start_ledger`)
- Order stuck in `ordering` → `backend/src/jobs.js reconcileOrderingFulfillment` logs
- vcc callback rejected → `backend/src/api/vcc-callback.js` (HMAC + timestamp window)
- Webhook to agent not delivered → `webhook_queue` table; `retryWebhooks` job
- Approval stuck → `approval_requests` table; `expireApprovalRequests` job
- Circuit breaker frozen → `system_state` keys `frozen`, `consecutive_failures`; unfreeze via `POST /admin/system/unfreeze`
