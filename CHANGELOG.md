# Changelog

All notable changes to cards402 (backend, SDK, web, contract) are recorded
here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — 2026-04-12 "Path to Perfect" audit sweep

**Backend**

- **HMAC v2 callback protocol** — `lib/hmac.js` shared signer/verifier
  (mirrored into vcc). v2 binds `order_id` into the signing payload and
  sends `X-VCC-Order-Id` header so a valid signature for one order can't
  be replayed against another. v1 legacy signatures still accepted during
  rollout. Replay window increased from 5 min to 10 min. Audit findings
  A-11, C-4, C-5.
- **End-to-end correlation IDs** — `X-Request-ID` threaded from
  `POST /v1/orders` through `orders.request_id`, `vcc-client.getInvoice`,
  and back in `/vcc-callback`. Every vcc log line now carries
  `[job:abcd req:abcd]`. Audit C-1.
- **`GET /admin/health`** — watcher lag, order status distribution,
  webhook delivery rate, admin-action volume, and card-retention stats
  in one JSON response for the System Health dashboard. Audit A-20.
- **`admin_actions` audit log** — every destructive admin op records
  actor / action / target / metadata / IP / request ID. `GET /admin/admin-actions`
  endpoint for querying. Migration 12. Audit A-17.
- **Per-origin webhook circuit breaker** — 5 failures in 60s opens the
  circuit for 5 min. One slow customer webhook can't stall delivery for
  everyone. Audit A-7.
- **vcc-client circuit breaker** — cards402 → vcc path trips after 3
  consecutive 5xx responses for 30s to avoid hammering a down vcc. Audit C-7.
- **SDK built-in retry** — `Cards402Client` gained `fetchWithRetry` with
  configurable attempts/backoff/jitter on 429/502/503/504 and network
  errors. `createOrder` is safe to retry thanks to existing idempotency
  keys. Audit A-23.
- **`GET /v1/orders` date filters** — `since_created_at`,
  `since_updated_at`, `offset` query params so agents can poll for
  deltas without refetching history. SDK `listOrders()` updated. Audit A-19.
- **CSV export streaming** — `/admin/orders?format=csv` now streams rows
  via `better-sqlite3`'s `iterate()` instead of materialising. Hard cap
  raised to 20k for CSV, kept at 500 for JSON. Pagination via `offset`.
  Audit A-9, A-32.
- **`dashboard_id` filter** on `/admin/orders`. Audit A-13.
- **Policy corruption is fail-closed** — malformed `policy_allowed_hours`
  or `policy_allowed_days` now returns `blocked` with a distinct reason
  and emits a `policy.corrupt` bizEvent. Storage-time validation already
  existed; this is defence in depth. Audit A-10.
- **Structured logging for payments** — `xlm-sender.js::payCtxOrder`
  emits a `ctx.paid` bizEvent with a masked Stellar destination
  (`GABC...XYZ`) instead of logging full addresses via console.log.
  Audit A-3.
- **HTTPS enforcement middleware** — production only, honoring
  `X-Forwarded-Proto` via `trust proxy`. Returns 426 for HTTP requests.
  Audit A-25.
- **Schema version sanity check** — `EXPECTED_SCHEMA_VERSION` declared in
  `db.js`; startup fails hard if the on-disk schema is ahead of the
  running binary. Audit A-5.
- **WAL checkpoint** after `saveStartLedger` to flush the cursor to the
  main db file. Audit A-12.
- **vcc-client 401 rotation logging** — every token deletion path now
  emits a `vcc.token_rotated` bizEvent with reason + response snippet
  before deleting the stored token. Audit A-4.
- **Idempotency metrics** — `idempotency.cache_hit` and
  `idempotency.conflict` bizEvents. Audit A-8.

**Env schema hardening**

- `SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM` added with email + numeric
  validation and an all-or-nothing superRefine (audit A-2).
- `VCC_CALLBACK_SECRET` min length raised 16 → 32 (audit C-13).
- Recovery-job knobs (`STUCK_RETRY_AFTER_MS`, `STUCK_FAIL_AFTER_MS`,
  `MAX_FULFILLMENT_ATTEMPTS`) declared in Zod (audit A-21).
- `ADMIN_SESSION_KEY` validated as 64-hex (audit A-6).

**SDK**

- MCP server version now imported from `package.json` (audit A-38).
- `Cards402Client.listOrders()` gained date and pagination filters (audit A-19).
- Built-in retry layer (audit A-23).

**Testing**

- 29 new unit tests for `lib/hmac.js` covering v1/v2 sign/verify, replay
  skew, hex validation, `safeEqHex` edge cases.
- 3 new `admin_actions` integration tests.
- 2 new `X-Request-ID` propagation tests.
- cards402 backend: 161 → 193 tests passing.
- cards402 SDK: 54 tests passing.

**Documentation**

- `docs/audits/2026-04-12-path-to-perfect.md` — strategic audit + 10-step
  sequence for the follow-on work.
- `docs/audits/2026-04-12-full-findings.md` — all 90 findings with stable
  IDs, file:line refs, and inline `Status:` tracking.
- `docs/audits/2026-04-12-worklog.md` — live narrative of every commit
  in the sweep.
- `ARCHITECTURE.md` §"Callback signature" updated for v2 wire format.

### Changed

- `express.json` body limit of 64kb now documented as covering the
  vcc-callback route (audit C-11).

### Fixed

- vcc-callback handler is now DB-atomic on both fulfilled and failed
  branches (claim-style UPDATE WHERE NOT IN terminal set) — eliminates
  parallel-callback race. Audit C-6.

### Security

- Stellar txids and destinations no longer printed to unredacted stdout.
  Audit A-3.
- **Platform-owner helper hardening** — `lib/platform.js::isPlatformOwner`
  now fails closed on non-string truthy input (pre-fix, a number / boolean /
  object reached `.trim()` and threw TypeError) and on whitespace-only
  inputs where both sides collapsed to empty (pre-fix, `'' === ''` returned
  TRUE and granted platform-owner to anyone with an empty email). Added
  first-time test coverage for `requirePlatformOwner` and `requireOwner`
  middleware — both had zero direct tests. Audit F1-platform / F2-platform.
- **Card-brand normaliser observability** — `lib/normalize-card.js` now
  returns `null` for whitespace-only upstream input (pre-fix, `'   '` was
  silently rendered as `'USD Prepaid Card'`, hiding upstream data
  corruption behind a plausible-looking label). Added dedup'd warn +
  `normalize_card.unknown_brand` bizEvent on the unknown-scheme fallback
  path so ops get a push signal the first time CTX introduces a new
  product SKU — previously the fallback was completely silent despite
  an inline comment claiming ops visibility. Audit F1/F2-normalize-card.
- **VCC client circuit breaker correctness** — two semantic bugs in the
  cards402 → vcc circuit breaker: (1) `recordVccSuccess` unconditionally
  cleared `openedUntil`, so a call that was in flight when the breaker
  tripped could complete successfully and reopen the gate for every
  subsequent caller even though VCC was still broken; now the cooldown
  is respected and success only clears the timestamp after it has
  expired naturally. (2) The documented "3+ errors in the last 60s"
  trip rule had no time window — `failures` accumulated forever until
  a success or trip, so a low-traffic caller hitting VCC once per hour
  would trip after N stale failures across N days; now a failure more
  than 60s after the previous one resets the counter to 1. Also added
  a typeof guard to `decryptToken` so a non-string
  `system_state.value` can't wedge the token path with an opaque
  TypeError. Audit F1/F2/F3-vcc-client.
