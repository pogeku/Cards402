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
- **Mobile nav sheet now opens to full viewport height.** The sticky
  top nav uses `backdrop-filter: blur(...)`, which (per CSS spec) turns
  the nav into a containing block for `position: fixed` descendants —
  so the mobile sheet's `top: 64, bottom: 0` was being calculated
  relative to the 64px nav instead of the viewport, collapsing the
  sheet to ~0px of content. Portaled the sheet to `document.body` so
  it escapes the nav's containing-block scope and is genuinely
  viewport-fixed.
- **More-menu hover/click interaction.** The "More" dropdown used to
  open on hover and then CLOSE if the user clicked the button — a
  clunky interaction because most users read the button as
  navigable and instinctively click it, instantly dismissing the
  dropdown they just opened. Click now only opens the dropdown (never
  closes it); hover on/off still controls both directions, and
  keyboard users can still activate via Enter/Space since click →
  open. ESC and click-outside still dismiss.

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
- **Agent funding check — testnet correctness + Horizon observability** —
  two fixes in `jobs.js::checkAgentFundingStatus` (the Horizon poller
  that flips `awaiting_funding → funded` when an agent wallet receives
  XLM or USDC). (1) **Testnet USDC detection**. The USDC issuer was
  hardcoded to `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
  — Circle's **mainnet** issuer. Any testnet deployment
  (`STELLAR_NETWORK=testnet`) silently failed to match USDC balances
  because the testnet USDC issuer is different, so agents who funded
  with USDC only were stuck in `awaiting_funding` forever. `env.js`
  already exposed `STELLAR_USDC_ISSUER` as the canonical config (and
  `xlm-sender.js` read from it), but this function ignored it. Also
  fixed the hardcoded `https://horizon.stellar.org` URL to pick the
  testnet Horizon URL when `STELLAR_NETWORK=testnet`. Both changes
  default to the mainnet values when the env is unset, so existing
  deployments are unaffected. (2) **Horizon HTTP error observability**.
  Pre-fix, every non-2xx response was silently `continue`d with zero
  ops signal — a Horizon outage (429/500/503/network exception)
  broke funding detection for every awaiting agent and nothing in
  the alerting pipeline saw it. Now 404 stays quiet (expected
  "wallet unactivated") but every other error emits a dedup'd
  `funding.horizon_error` bizEvent — once per outage window, not
  once per awaiting wallet, so a 500-agent dashboard doesn't flood
  alerting. Recovery emits `funding.horizon_recovered` and clears
  the dedup so subsequent outages re-alert. Network exceptions
  (ECONNREFUSED, timeout, DNS) go through the same dedup path.
  Audit F1/F2-funding.
- **Background job loop hardened** — two fixes in src/jobs.js. (1)
  **Validated interval env vars**. `FUNDING_CHECK_INTERVAL_MS` and
  `ALERT_INTERVAL_MS` were previously parsed with
  `parseInt(process.env.X || default, 10)` which silently produced
  `NaN` for any non-numeric value. Per the Node docs,
  `setInterval(fn, NaN)` clamps to **1 ms** — so a single env-var
  typo like `FUNDING_CHECK_INTERVAL_MS=abc` would fire the
  funding-check callback ~1000 times per second, saturating CPU and
  hammering Horizon. Added a `parsePositiveMs()` helper that clamps
  to `[1s, 24h]`, falls back to the caller default on any invalid
  value, and emits a dedup'd one-shot `console.warn` per offending
  env var. (2) **Isolated sub-job failures**. `runJobs()` used to
  wrap its 12 sub-jobs in one outer try/catch — so the first job to
  throw (corrupt row, DB lock, transient VCC error) would exit the
  function and skip every subsequent job for the entire life of the
  process. One bad row in `expireStaleOrders` could wedge webhook
  retries, pruning, card expiry, and everything else. Added a
  `_runSubJob(name, fn)` helper that wraps each sub-job in its own
  try/catch + `jobs.subjob_failed` bizEvent. Every sub-job now runs
  independently; a failure logs + alerts and the chain continues.
  Audit F1/F2-jobs.
- **Process-level handlers hardened** — two fixes in src/index.js
  (the production entrypoint). (1) **SIGHUP is now handled** — SIGINT
  and SIGTERM were routed to the graceful-shutdown path but SIGHUP
  was unhandled, so a pm2 reload / systemd HUP / Docker stop would
  invoke Node's default SIGHUP behaviour and terminate the process
  without draining in-flight orders, SSE streams, or webhook
  deliveries. (2) **unhandledRejection now emits a structured
  `process.unhandled_rejection` bizEvent** — the old handler did
  only `console.error('... at', promise, 'reason:', reason)`, which
  stringified the Promise arg as `[object Promise]` and left the log
  line nearly useless. Ops alerting pipelines that scrape bizEvents
  had no push signal for a class of error that's almost always a
  real programming bug. Extracted the payload builder to
  src/lib/process-handlers.js::formatRejection so it can be
  unit-tested in isolation (index.js has production side effects at
  module load and can't be required by tests). The formatter handles
  every pathological reason shape the retry.js / sanitize-error.js
  audits taught us to expect: null, undefined, strings, Errors with
  getter-thrown .message or .stack, non-Error objects, revoked
  Proxies (where even `instanceof Error` throws), Symbols, BigInts.
  Audit F1/F2-index.
- **Client-supplied X-Request-ID validated** — the request-id
  middleware at the top of src/app.js previously accepted any
  client-supplied `X-Request-ID` header, `.slice()`'d to 36 chars, and
  stamped it onto `req.id`, the response header, the `orders.request_id`
  DB column, and the outbound VCC `X-Request-ID` header. Three real
  problems: (1) a client sending `X-Request-ID: foo\r\nBcc: attacker`
  would trip `res.setHeader`'s `ERR_INVALID_CHAR` check and 500 every
  one of their own requests before any route handler ran. (2) Garbage-
  shaped ids persisted to the DB and later fed to vcc-client's outbound
  fetch would crash those fetches with cryptic header errors unrelated
  to the real failure. (3) Attacker-controlled correlation ids in ops
  logs looked indistinguishable from server-generated ones — forensics
  couldn't tell which rows to trust. Fix validates the header against
  a narrow charset (alphanumeric + dash + underscore + dot + colon,
  length 1-64) that still accepts UUIDs, OpenTelemetry 32-char hex
  trace ids, Sentry event ids, and common SDK formats. Invalid or
  missing headers fall back to a server-generated UUID and emit a
  dedup'd `request.invalid_request_id` bizEvent per offending IP so
  ops sees systematic misuse without log spam. Audit F1-app.
- **Environment schema hardening** — five fixes in src/env.js, the
  boot-time validator. (1) **Stellar strkey shape** —
  `STELLAR_USDC_ISSUER`, `STELLAR_XLM_SECRET`, and `RECEIVER_CONTRACT_ID`
  were validated only by the first character. A typo like
  `STELLAR_XLM_SECRET=S` or `RECEIVER_CONTRACT_ID=Cwrong` passed boot
  and crashed at first use with a cryptic Stellar SDK decode error.
  Now enforced as exactly 56 base32 characters with the correct type
  prefix. (2) **`INTERNAL_EMAILS` per-entry validation** — a
  comma-separated string was stored opaquely; a typo silently excluded
  the intended operator from `/internal/*` routes with no boot-time
  signal. Each entry is now trimmed, lowercased, and validated at
  boot. (3) **`CORS_ORIGINS` per-entry validation** — same class of
  bug; each entry is now parsed as an http(s) URL at boot. (4) **URL
  scheme constraint** — `CARDS402_BASE_URL`, `VCC_API_BASE`, and
  `SOROBAN_RPC_URL` previously accepted any scheme (`ftp://`, `file://`,
  `javascript:`, `chrome-extension://`) because zod's `.url()` is
  protocol-agnostic. Now constrained to http/https. (5) **RFC 6761
  reserved TLDs** — the "production lookalike" guard (`NODE_ENV !=
production` + HTTPS + non-local = fail) treated `.test` and
  `.localhost` as non-local despite RFC 6761 reserving them for
  testing. Added them to the local-host list so a legitimate
  `.test`/`.localhost` deploy isn't mis-flagged as production.
  Also fixed two pre-existing test-harness fakes that the new strkey
  regex caught (55-char XLM secret off-by-one, contract ID containing
  `0` outside the base32 alphabet). Audit F1/F2/F3/F4/F5-env.
- **Fulfillment refund correctness + webhook breaker race** — two
  fixes in src/fulfillment.js. (1) **Refund now includes
  `excess_usdc`** — the USDC refund path previously sent
  `order.amount_usdc` (the QUOTED amount) regardless of how much the
  agent actually paid. An agent overpaying by $0.50 against a $10.00
  order had the overpayment tracked in `order.excess_usdc` by
  payment-handler.js, but the refund handler silently ignored that
  column and refunded only $10.00 — quietly keeping the $0.50 on a
  failed order. This was a financial correctness bug: cards402 took
  customer money on every failed overpaid order. Fix sums
  `amount_usdc + excess_usdc` in BigInt stroop precision and refunds
  the total. Corrupt `excess_usdc` values are treated as zero (fail-
  safe, cannot inflate the refund). The `refund.sent` bizEvent now
  emits `quoted_amount` and `excess_amount` alongside the total for
  ops visibility. (2) **Webhook circuit-breaker race** —
  `recordCircuitSuccess` unconditionally cleared `openedUntil`, so an
  in-flight webhook request that was fired before the breaker tripped
  could complete successfully and wipe the cooldown timestamp —
  reopening the gate for every subsequent caller even though the
  origin was still broken. Same bug class as vcc-client F1 earlier
  this session; fix is identical (leave `openedUntil` intact during
  active cooldown, zero `failures` unconditionally). Audit
  F1/F2-fulfillment.
- **Payment handler treasury-drain guard + catch-block resilience** —
  three fixes in the Soroban payment handler that gates the
  pending_payment → ordering transition. (1) `toStroops('')` returns
  `0n`, so if `order.amount_usdc` was ever empty (migration, manual
  UPDATE, schema drift), any positive on-chain payment compared as
  "overpayment of 0" and the order transitioned to ordering — cards402
  would then spend treasury to fulfill a $0-quoted order. Added
  `parseStrictPositiveStroops()` which requires a non-empty digits-
  only decimal string parsing to a positive stroop value; corrupt rows
  now route the incoming event to unmatched_payments with
  reason=corrupt_order and the order stays in pending_payment. (2) The
  outer fulfillment catch handler used to read `err.message` with no
  defence — a non-Error thrown value or an Error with a getter-thrown
  `.message` would crash the catch block itself, skipping the
  "mark failed + schedule refund" cleanup and leaving the order
  wedged in ordering status until the reconciler picked it up minutes
  later. Added `safeErrorMessage()` helper (same pattern as
  lib/retry.js). (3) USDC overpayment now emits a symmetric
  `payment.usdc_overpaid` bizEvent — XLM already had
  `payment.xlm_overpaid` but USDC was silent, so a buggy SDK
  systematically over-paying would have silently accumulated excess
  without ops visibility. Audit F1/F2/F3-payment-handler.
- **Stellar watcher dispatch-retry correctness** — two latent bugs in
  the Soroban payment watcher's poison-pill breakout. (1) The
  per-event retry map used a 1024-entry "LRU" eviction that was
  actually FIFO (JS `Map.set` on existing keys does NOT reorder
  insertion order), and an evicted entry's counter restarted from 0
  on next failure. A cascading-failure cascade (1024 events mid-retry)
  could cause an actively-poisoning event to be evicted at count=4
  and silently reset to 0 — defeating the whole poison-pill breakout.
  Fix raises the cap to 8192, eliminates eviction entirely, and
  dead-letters any new events beyond the cap immediately with a
  `stellar.dispatch_retry_map_full` bizEvent for ops visibility.
  (2) `serialiseEventForDeadLetter` had no size cap, so a hostile or
  malformed event with a multi-MB payload would write a multi-MB row
  to `stellar_dead_letter` — amplifying one adversarial event into
  significant storage cost and breaking the dead-letter table as a
  grep-able forensic surface. Now truncates at 16KB with a
  `{_truncated, _original_bytes, preview}` marker matching the
  `audit_log.details` cap pattern. Audit F1/F2-stellar.
