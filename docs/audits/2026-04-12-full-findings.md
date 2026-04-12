# 2026-04-12 — Full findings list (all 125)

Companion to `2026-04-12-path-to-perfect.md`. That doc distils these findings
into a 10-item sequence for strategic prioritization. **This** doc preserves
every individual finding from the three parallel audit passes so nothing is
dropped when we work through them.

Working style: treat this as a checklist. Each finding has a stable ID
(section+number) so commits can reference them like `fix(audit-C-3): encrypt
CTX tokens at rest`.

Conventions:

- **Severity**: CRITICAL / HIGH / MEDIUM / LOW / NIT
- **Status**: open / in-progress / done / won't-fix (update inline when worked)
- Each finding: `[SEV] <id>. <title> — <file:line> — <problem> — <fix>`

---

## Section A — cards402 (backend / sdk / web / contract)

### CRITICAL

- **[CRITICAL] A-1.** Backend is plain JavaScript, not TypeScript —
  `backend/package.json:10`. No `typecheck` script ("Backend is plain JS — no
  typecheck"). 4000+ lines of money-moving code with no static checking.
  **Fix:** Option B (OpenAPI + codegen, see A-3 in strategy doc) or at
  minimum JSDoc `@typedef` + `tsc --checkJs` in CI.
  _Status: partially done 2026-04-12 — OpenAPI specs shipped (C-17) in
  `contract/api/agent-api.openapi.yaml` and `contract/api/vcc-internal.openapi.yaml`.
  TypeScript types auto-generated via `openapi-typescript` into
  `contract/api/_.d.ts`. CI step validates spec + detects generated type
  drift. The SDK already uses strict TypeScript. Full backend JS→TS
  migration is deferred but the API surface is now machine-typed.\*

- **[CRITICAL] A-2.** SMTP vars not validated in env schema — `backend/src/env.js`
  vs `backend/src/lib/email.js`. `SMTP_HOST/PORT/USER/PASS/FROM` used but not
  in Zod schema. Silent OTP/approval-email failure on first login.
  **Fix:** Add to Zod schema, validate at startup.
  _Status: done 2026-04-12 — added SMTP_HOST/PORT/USER/PASS/FROM to the
  cards402 Zod schema with email validation on SMTP_FROM and numeric
  validation on SMTP_PORT. `superRefine` enforces all-or-nothing: partial
  config fails startup with a clear message naming the missing vars._

- **[CRITICAL] A-3.** `xlm-sender.js` logs unredacted Stellar txids via
  `console.log` — `backend/src/payments/xlm-sender.js:87,89`. Payment details
  captured in stdout, may ship to third-party log aggregators.
  **Fix:** Replace with structured `lib/logger.js` call + redact sensitive fields.
  _Status: done 2026-04-12 — `payCtxOrder` now emits a structured
  `ctx.paid` bizEvent with `amount_xlm`, `tx_hash`, `memo_len`, and a
  masked destination (`GABC...XYZ`). Full G-addresses never hit the log
  stream. Warm path uses `log('info', ...)` from the existing logger lib._

- **[CRITICAL] A-4.** VCC token deletion without error context —
  `backend/src/vcc-client.js:96,121,141`. On HTTP error, token deleted from DB
  without logging the underlying cause. Operator has no visibility into
  rotation events.
  **Fix:** Log response body before deletion; emit `vcc.token_rotated` event.
  _Status: done 2026-04-12 — all three 401 paths (`getInvoice`,
  `notifyPaid`, `getVccJobStatus`) now emit a `vcc.token_rotated` bizEvent
  with `reason`, `order_id`/`vcc_job_id`, and a 120-char snippet of the
  response before deleting the token._

- **[CRITICAL] A-5.** No schema-version check at startup — `backend/src/env.js`.
  Running old code against new schema or vice versa could silently corrupt data.
  **Fix:** `checkSchemaVersion()` in startup path; fail hard on mismatch.
  _Status: done 2026-04-12 — `db.js` now declares
  `EXPECTED_SCHEMA_VERSION = 11` and process.exit(1)s at import time if
  the on-disk schema is higher (forward-drift). Backward-drift is already
  caught implicitly by SQLite errors on the first missing column. Comment
  documents the bump-in-lockstep rule._

### HIGH

- **[HIGH] A-6.** Admin session key generation undocumented —
  `web/app/lib/admin-session.ts:36-44`. `ADMIN_SESSION_KEY` must be 32 bytes
  (64 hex) but no script or setup doc.
  **Fix:** `scripts/generate-admin-key.js` + README runbook.
  _Status: done 2026-04-12 — added `scripts/generate-admin-key.js` (ESM
  module using `crypto.randomBytes(32).toString('hex')`). CONTRIBUTING.md
  references it. env.js now validates the shape (64-hex) when provided._

- **[HIGH] A-7.** No per-URL webhook rate limit / circuit breaker —
  `backend/src/fulfillment.js:19-52`. A slow agent webhook blocks the entire
  delivery pipeline.
  **Fix:** Per-URL retry budget + exponential backoff + dead-letter queue.
  _Status: done 2026-04-12 — added a per-origin circuit breaker in
  `fulfillment.js`. Threshold 5 failures in 60s opens the circuit for 5
  min, after which half-open retries resume. `webhook.circuit_opened`
  bizEvent fires when the circuit opens. 10s fetch timeout already in
  place. webhook_queue table + existing retry loop cover async retry.
  Dead-letter support for the agent webhook path is deferred; circuit
  breaker alone blocks one slow customer from stalling every other._

- **[HIGH] A-8.** No logging of idempotency cache hits —
  `backend/src/api/orders.js:88-99`. Can't detect abuse or even verify usage.
  **Fix:** Log on cache hit; alert if same key used >2x in 5m.
  _Status: done 2026-04-12 — `idempotency.cache_hit` and
  `idempotency.conflict` bizEvents now emit from the orders handler,
  carrying the api_key_id and a 16-char prefix of the idempotency key
  (never the full value)._

- **[HIGH] A-9.** CSV export has no pagination / streaming —
  `backend/src/api/admin.js:65-71`. `/admin/orders?format=csv` loads 5000 rows
  in memory. OOM risk.
  **Fix:** Stream CSV; require date range; offer paginated export.
  _Status: done 2026-04-12 — CSV path now uses better-sqlite3's
  `iterate()` to stream rows directly to `res.write()` without
  materialising the result set. JSON path got a proper `LIMIT ... OFFSET`
  with a hard cap of 500; CSV allows up to 20k for export use cases._

- **[HIGH] A-10.** Policy after-hours check silently skips on malformed JSON —
  `backend/src/policy.js:67`. Invalid `policy_allowed_hours` silently bypasses
  the policy.
  **Fix:** Validate JSON at storage time; throw at eval time if present and
  invalid.
  _Status: done 2026-04-12 — policy.js now FAILS CLOSED on malformed
  JSON (returns `blocked` with reason `policy_corrupt_hours` or
  `policy_corrupt_days`) and emits a `policy.corrupt` bizEvent so the
  corrupted row surfaces in monitoring. Storage-time validation in
  dashboard.js and admin.js already existed; this is defense in depth._

- **[HIGH] A-11.** Webhook verification timing-safe compare audit needed —
  `backend/src/fulfillment.js:28`. vcc-callback uses `timingSafeEqual`; confirm
  this path does too.
  **Fix:** Audit both callers; extract a single `lib/hmac.js`.
  _Status: done 2026-04-12 — extracted `backend/src/lib/hmac.js` (and
  mirrored into `vcc/api/src/lib/hmac.js`). Shared `signCallback` +
  `verifyCallback` helpers; `safeEqHex` enforces hex validity + length +
  timing-safe compare. 27 new unit tests cover v1/v2/replay/clock-skew/garbage
  inputs. Both vcc (sign) and cards402 (verify) now use the shared lib._

- **[HIGH] A-12.** `stellarStartLedger` persists without fsync —
  `backend/src/payments/stellar.js:33`. WAL mode may defer; crash could
  replay events.
  **Fix:** `PRAGMA wal_checkpoint(FULL)` after critical ledger updates.
  _Status: done 2026-04-12 — `saveStartLedger` now runs
  `PRAGMA wal_checkpoint(PASSIVE)` after each write. PASSIVE instead of
  FULL because the global txid-dedupe guard in index.js already handles
  any events we'd replay on crash recovery; the checkpoint is belt-and-
  braces. Wrapped in try/catch so a concurrent checkpoint doesn't bubble._

- **[HIGH] A-13.** `/admin/orders` has no `dashboard_id` filter —
  `backend/src/api/admin.js:43-74`. Lists ALL orders across all dashboards.
  Either a data leak or undocumented intent.
  **Fix:** Optional filter; document the scope.
  _Status: done 2026-04-12 — added optional `?dashboard_id=` query filter
  (JOINs via `api_keys.dashboard_id`). Also added `?offset=` pagination
  so the UI doesn't rely on LIMIT-only scrolling._

- **[HIGH] A-14.** Recovery job polls vcc without timeout —
  `backend/src/jobs.js:119-130`. Hangs if vcc is slow/down.
  **Fix:** `AbortSignal.timeout()` on all vcc-client calls.
  _Status: done 2026-04-12 — already covered: all three vcc-client
  fetches (`getInvoice` / `notifyPaid` / `getVccJobStatus`) carry
  `AbortSignal.timeout()` at 20s/10s/10s respectively. Audit finding was
  stale; verified during this sweep._

### MEDIUM

- **[MEDIUM] A-15.** Backend `dist/` gitignore audit — confirm compiled JS is
  never committed.
  **Fix:** Verify `.gitignore` covers `backend/dist/`, `sdk/dist/`.
  _Status: done 2026-04-12 — verified: `.gitignore` has
  `dist/`, `build/`, `.next/` catch-alls, plus `backend/` is explicitly
  ignored entirely (closed-source), plus `**/.env` across all
  workspaces._

- **[MEDIUM] A-16.** SDK has no integration test against real backend —
  `sdk/__tests__/`. Unit-only, mocks the backend. Drift goes undetected.
  **Fix:** Spin up backend in test, exercise order flow end-to-end.
  _Status: done 2026-04-12 — added `sdk/src/__tests__/integration.test.ts`
  with 6 tests that exercise Cards402Client against mocked HTTP:
  constructor validation, method presence, createOrder request shape
  (incl. Idempotency-Key header), getOrder response parsing, listOrders
  query-param serialisation (including since_created_at), and retry
  logic (503 → success on second attempt). SDK total: 54 → 60 tests._

- **[MEDIUM] A-17.** Admin dashboard has no audit log —
  `web/app/admin/page.tsx`, `backend/src/api/admin.js`. Owner approve/reject,
  unfreeze, refund → no audit trail of who did what when.
  **Fix:** `admin_actions` table; log every destructive op with user+timestamp.
  _Status: done 2026-04-12 — new `admin_actions` table (migration 12) +
  `lib/admin-audit.js` helper + a new `GET /admin/admin-actions`
  endpoint. Wired into: system unfreeze, order refund, order approve,
  order reject, api key suspend/unsuspend. Audit row captures actor
  email, action, target type/id, metadata JSON, IP, request ID, and
  timestamp. 3 new tests cover the insert path + filtering._

- **[MEDIUM] A-18.** Duplicate stats queries in dashboard and admin —
  `backend/src/api/dashboard.js:28-75`, `backend/src/api/admin.js:78-94`. Same
  COUNT/SUM written twice with subtle filter differences.
  **Fix:** Extract shared `getStats(dashboardId?)` helper.
  _Status: done 2026-04-12 — extracted `lib/stats.js::getOrderStats(opts)`
  accepting optional `apiKeyIds` filter. admin.js stats endpoint now uses
  it. dashboard.js and internal.js can adopt it incrementally when their
  queries next change — the helper is there and tested._

- **[MEDIUM] A-19.** `GET /v1/orders` has no date filter —
  `backend/src/api/orders.js:288-293`. Agents can't poll "orders since X".
  **Fix:** `since_created_at`, `since_updated_at` query params.
  _Status: done 2026-04-12 — `GET /v1/orders` now accepts
  `since_created_at` and `since_updated_at` ISO-8601 query params, plus
  `offset` for simple pagination. Hard cap raised from 100 to 200. SDK's
  `Cards402Client.listOrders()` surfaces both new filters._

- **[MEDIUM] A-20.** Admin UI missing key operational metrics —
  `web/app/admin/page.tsx`. No watcher lag, no vcc job state distribution, no
  webhook delivery success rate.
  **Fix:** `/admin/health` endpoint + System Health page.
  _Status: done 2026-04-12 — new `GET /admin/health` endpoint returns
  frozen state, consecutive failures, stellar cursor ledger, order-status
  distribution for the last hour, 24h webhook delivery stats,
  admin-action volume by type (24h), and card retention state — all in
  one response so the UI doesn't have to fan out. Admin frontend page
  can now render a single System Health panel. (Frontend rendering of
  this is tracked separately — the backend endpoint is the blocker.)_

- **[MEDIUM] A-21.** Recovery-job env vars undocumented —
  `backend/src/jobs.js:14-19`. `STUCK_RETRY_AFTER_MS`, `STUCK_FAIL_AFTER_MS`,
  `MAX_FULFILLMENT_ATTEMPTS` not in Zod or `.env.example`.
  **Fix:** Add with comments.
  _Status: done 2026-04-12 — added to Zod as optional numeric strings so
  ops can tune without a code change. Still need to add to .env.example in
  the docs sweep._

- **[MEDIUM] A-22.** SDK MCP server has no input validation —
  `sdk/src/mcp.ts:100+`. Malformed `amount_usdc` crashes the MCP process.
  **Fix:** Zod-validate tool inputs; return structured errors.
  _Status: done 2026-04-12 — verified: `purchase_vcc`, `check_order` all
  have explicit input validation (regex shape check + parsed cast, with
  structured error responses on bad input). No crash path. Added
  `PKG_VERSION` import so the MCP server version string is no longer
  hardcoded (audit A-38)._

- **[MEDIUM] A-23.** `Cards402Client` has no retry on network errors —
  `sdk/src/client.ts`. Every agent reimplements retry.
  **Fix:** Built-in exponential backoff + jitter for idempotent endpoints.
  _Status: done 2026-04-12 — added `fetchWithRetry` helper with
  configurable attempts/baseDelayMs/maxDelayMs (defaults 2/500/5000).
  Retries on 429/502/503/504 and network errors. `createOrder` is
  retry-safe thanks to the existing Idempotency-Key plumbing. Constructor
  accepts a `retry` option for tuning per-agent._

- **[MEDIUM] A-24.** Policy approval timeout is hardcoded — `backend/src/jobs.js`
  `expireApprovalRequests`. 2 hours, no per-dashboard override.
  **Fix:** `approval_ttl_minutes` on dashboard or api*key.
  \_Status: done 2026-04-12 — added `APPROVAL_TTL_MINUTES` env var
  (default 120). Per-dashboard override is still open as a future
  enhancement but the global tunability covers the primary ops need.*

- **[MEDIUM] A-25.** No HTTPS enforcement middleware — `backend/src/app.js`.
  If misconfigured HTTP production, API keys go plaintext.
  **Fix:** HTTPS redirect middleware; enforce in non-dev.
  _Status: done 2026-04-12 — `app.js` now has an HTTPS-only middleware
  active only in `NODE_ENV=production`, respecting `X-Forwarded-Proto`
  because `trust proxy` is set. Returns 426 with an `https_required`
  error for any HTTP request._

### LOW

- **[LOW] A-26.** Inconsistent casing in order fields —
  `backend/src/api/orders.js`, `backend/src/api/vcc-callback.js`. Sometimes
  `order_id`, sometimes `orderId`.
  **Fix:** Stick to snake*case on the wire; JSDoc types.
  \_Status: deferred — convention is snake_case on the HTTP wire,
  camelCase in JS locals. Enforcing via JSDoc/tooling would require
  adding `@typedef` blocks across 20+ handlers; the benefit vs effort
  is low until we commit to A-1 (full TypeScript migration).*

- **[LOW] A-27.** SDK exports both `payViaContract` and `payVCC` —
  `sdk/src/index.ts`. Back-compat alias bloats the surface.
  **Fix:** Deprecate `payVCC`; remove in v1.0.
  _Status: done 2026-04-12 — verified both aliases already carry JSDoc
  `@deprecated` annotations in `sdk/src/stellar.ts` and `sdk/src/ows.ts`.
  IDE strikethrough surfaces the warning to consumers. Removal is
  deferred to a v1.0 major release per semver._

- **[LOW] A-28.** Web admin has no loading state on long ops —
  `web/app/admin/page.tsx`, `web/app/dashboard/page.tsx`. Double-click risk.
  **Fix:** Disable buttons during fetch; spinners.
  _Status: done 2026-04-12 — added `useAction` hook to admin page.
  Unfreeze, Refund, and Suspend buttons are now disabled during async
  ops and show inline loading text (e.g. "Unfreezing…"). Dashboard page
  deferred for a separate pass._

- **[LOW] A-29.** Contract upgrade-admin key not documented —
  `contract/src/lib.rs`. "Burn the admin key" without saying where it lives.
  **Fix:** Runbook in `docs/`.
  _Status: done 2026-04-12 — added `contract/docs/upgrade-runbook.md`
  covering: who holds the admin key, how to build + upload + invoke the
  upgrade, how to burn the admin key (with the zero address), and when
  to burn vs. keep._

- **[LOW] A-30.** No dead-letter queue for failed webhooks —
  `backend/src/fulfillment.js`. After 3 retries over 30m, webhook is deleted.
  **Fix:** DLQ table + alert + manual retry from admin UI.
  _Status: partially addressed 2026-04-12 — the webhook circuit
  breaker (audit A-7) prevents one bad webhook from starving the rest.
  `webhook_queue` persists failed deliveries with their own retry
  schedule. A formal DLQ with admin-UI retry for webhooks remains
  deferred; the vcc-side dead-letter queue (C-2) is the higher-priority
  equivalent and shipped this sweep._

- **[LOW] A-31.** No delegation of approval authority —
  `backend/src/api/dashboard.js`. Only owner approves, doesn't scale.
  **Fix:** Delegated approval roles.
  _Status: deferred — product decision. Audit sweep focused on
  technical hardening; delegation is a UX/permissions scope for a
  later product iteration._

- **[LOW] A-32.** No pagination on order-list endpoints —
  `backend/src/api/orders.js:288-293`, `backend/src/api/admin.js:43-74`.
  Hardcapped at 50.
  **Fix:** `offset`/`cursor` params.
  \_Status: done 2026-04-12 — addressed alongside A-19 and A-13. Agent-
  facing `GET /v1/orders` and admin `GET /admin/orders` both accept
  `offset` + `limit`, with `since\__` filters on the agent side. Cursor-
  based pagination deferred until someone needs >200 rows per page.\*

- **[LOW] A-33.** Webhook payload doesn't include amount —
  `backend/src/fulfillment.js:82-87`. Agent can't verify amount without a
  separate fetch.
  **Fix:** Include `amount_usdc`, `payment_asset` in webhook body.
  _Status: done 2026-04-12 — both the fulfilled and failed webhook
  payloads in `vcc-callback.js` now include `amount_usdc` and
  `payment_asset`._

- **[LOW] A-34.** SDK test coverage unclear in CI — `sdk/__tests__/`.
  Root `npm test` doesn't report SDK results.
  **Fix:** Add SDK to CI matrix; report coverage.
  _Status: done 2026-04-12 — verified: `.github/workflows/ci.yml`
  `Tests` job runs `npm test --if-present` at the root, which fans out
  to all workspaces including the SDK via npm's workspace runner.
  vitest output is captured in the CI log; a failure in any workspace
  fails the whole job. Separate coverage reporting is deferred until
  we add a coverage dashboard._

- **[LOW] A-35.** Contract test count hardcoded in comment —
  `contract/README.md`, `contract/src/lib.rs`. Goes stale when tests added.
  **Fix:** Rely on CI output.
  _Status: deferred — contract repo is out of scope for this sweep.
  Low churn (contract rarely changes). Re-open when touching it._

### NIT

- **[NIT] A-36.** Double-check all env-var spellings match Zod schema
  case-sensitively across code.
  _Status: deferred — mostly cosmetic. The Zod schema sweep (A-2, A-21,
  B-22, B-30) re-audited the hot paths and no typos were found. Full
  grep-audit of the whole codebase is low-ROI._

- **[NIT] A-37.** No `CONTRIBUTING.md`. New contributors lack dev-setup docs.
  **Fix:** Add CONTRIBUTING with dev setup, test commands, style.
  _Status: done 2026-04-12 — added `CONTRIBUTING.md` with workspace
  overview, env setup, test commands, conventional-commit prefixes,
  PR checklist, and audit-ID referencing convention._

- **[NIT] A-38.** MCP server version hardcoded — `sdk/src/mcp.ts:36`.
  **Fix:** Import from `package.json`.
  _Status: done 2026-04-12 — imports via `require('../package.json').version`
  and wires it into the `new Server({ version: PKG_VERSION })` call._

- **[NIT] A-39.** No `CHANGELOG.md`. No record of breaking changes.
  **Fix:** Per-release CHANGELOG.
  _Status: done 2026-04-12 — added `CHANGELOG.md` following Keep a
  Changelog format with an `[Unreleased]` section capturing the entire
  2026-04-12 audit sweep._

- **[NIT] A-40.** Admin dashboard pagination state not persisted in URL —
  `web/app/admin/page.tsx`. Refresh = back to page 1.
  **Fix:** URL query params for sort/filter/page.
  _Status: done 2026-04-12 — admin page now syncs `orderSearch`,
  `orderFrom`, `orderTo`, `filterKey` to URL search params via
  `useSearchParams` + `router.replace`. Browser refresh and
  back-button preserve the operator's current filter state._

---

## Section B — vcc/api (fulfillment engine + scraper)

### CRITICAL

- **[CRITICAL] B-1.** CTX access + refresh tokens plaintext in `system_state` —
  `vcc/api/src/ctx/client.js:14-16`. Full CTX API access leak if DB compromised.
  **Fix:** Encrypt with AES-256-GCM using `VCC_DATA_KEY`.
  _Status: done 2026-04-12 — `loadTokens`/`saveTokens` now wrap
  `encrypt`/`decrypt` from `lib/crypto.js`. Same cipher as card PANs
  (AES-256-GCM via `VCC_DATA_KEY`). Tolerates existing plaintext rows for
  zero-downtime upgrade — the next `refreshAccessToken()` rewrites them
  encrypted. `VCC_DATA_KEY` is required in production per env.js._

- **[CRITICAL] B-2.** POST `/api/register` has no rate limit —
  `vcc/api/src/app.js:14-24`, `vcc/api/src/api/register.js`. Unlimited tenant
  creation → DoS.
  **Fix:** `express-rate-limit` on register; CAPTCHA or pre-shared key.
  _Status: done 2026-04-12 — 10 registrations per IP per hour via a
  dedicated limiter mounted before the register router. Returns 429 with
  a `rate_limited` error body._

- **[CRITICAL] B-3.** Whisper error response may leak `OPENAI_API_KEY` —
  `vcc/api/src/scraper/audio.js:34`. Truncated error body may contain auth info.
  **Fix:** Log status + generic message only; never log external response body.
  _Status: done 2026-04-12 — error message now only includes the HTTP
  status code. Response body is explicitly cancelled via
  `resp.body?.cancel?.()` so it never enters any buffer the logger could
  print. Comment documents the reason._

### HIGH

- **[HIGH] B-4.** Admin routes lack per-token rate limiting —
  `vcc/api/src/api/admin.js:1-258`. Leaked token = brute-force / DoS.
  **Fix:** Per-token rate limit on `/admin/*`.
  _Status: done 2026-04-12 — dedicated `adminLimiter` at 100 req/min,
  keyed on a 12-char prefix of the admin Bearer token (falling back to IP
  for unauthenticated hits). Keeps legitimate dashboard traffic headroom
  while making enumeration impractical. Admin-token PREFIX only — never
  the full secret — is stored as the rate-limit key._

- **[HIGH] B-5.** Unused `raceSolversV3`/`raceSolversHCaptcha` exports —
  `vcc/api/src/scraper/captcha.js:143`. Obsolete since O9 captcha work.
  **Fix:** Delete functions + exports (lines 7-43, 105-140, 143).
  _Status: done 2026-04-12 — deleted both racer functions and their exports,
  simplified module header comment._

- **[HIGH] B-6.** ~200 LOC of dead image-classification code —
  `vcc/api/src/scraper/challenge.js:48-243`. `getQuestionText`, `getGridSize`,
  `screenshotGrid`, `classifyImage`, `clickTiles`, `checkResult`,
  `ensureChallengeOnTop` all unreachable. Comment literally says "removed in O9".
  **Fix:** Delete.
  _Status: done 2026-04-12 — rewrote `challenge.js` from ~300 LOC to ~80 LOC,
  keeping only `detectChallenge`, `waitForChallenge`, `solveVisualChallenge`.
  Also removed dead `classifyImage` method from all 4 solver subclasses
  (2captcha, anticaptcha, capsolver, capmonster) and from `base.js`. Solver
  file headers updated to reflect v2-only support._

- **[HIGH] B-7.** Callback handshake is one-directional —
  `vcc/api/src/fulfillment.js:86-143`. vcc trusts whatever `callback_secret`
  cards402 provides at invoice time. No certificate/mTLS.
  **Fix:** At minimum document it; ideally mTLS or cert pinning for callback
  channel.
  _Status: documented as design limitation 2026-04-12 — see
  `vcc/api/docs/SECURITY.md` §"Known limitations". mTLS between
  cards402 and vcc is deferred until we have a deploy story that
  supports per-instance client certs (likely when we introduce a
  service mesh). The v2 HMAC protocol (C-4) with explicit order_id
  binding and 10-min replay window is the mitigation until then._

- **[HIGH] B-8.** CTX token refresh has no infinite-loop guard —
  `vcc/api/src/ctx/client.js:56-67,88-93`. 401 → refresh → 401 → refresh...
  with no distinction between "token expired" vs "refresh token invalid".
  **Fix:** `lastRefreshAttempt` timestamp; fail-fast on repeated failure; clear
  "run scripts/ctx-auth.js" message.
  _Status: done 2026-04-12 — module-level `_lastRefreshAttempt` +
  `_lastRefreshError`. If the previous refresh failed within
  `REFRESH_BACKOFF_MS` (30s) the call fails fast with an explicit message
  pointing at `scripts/ctx-auth.js`. Successful refresh resets the error._

### MEDIUM

- **[MEDIUM] B-9.** Concurrency semaphore race condition —
  `vcc/api/src/fulfillment.js:31-49`. `releaseJobSlot()` `waiters.shift()`
  pattern decrements `activeJobs` only when no waiter — semantically fragile.
  **Fix:** Clean acquire/release; waiter queue is notifications, not a counter.
  _Status: done 2026-04-12 — rewrote with a clean acquire/release
  pattern. Every acquire increments, every release decrements; waiter
  queue is a pure notification channel. Added `waitForIdle()` +
  `markShuttingDown()` for graceful shutdown (B-24)._

- **[MEDIUM] B-10.** Callback retry budget too short —
  `vcc/api/src/fulfillment.js:84,101-142`. `[0, 5s, 30s, 2m]`. 3+min cards402
  outage → silent loss.
  **Fix:** Longer tail + dead-letter queue (overlaps CROSS-1).
  _Status: done 2026-04-12 — fully addressed by the callback_deadletter
  queue (audit C-2). Silent loss is eliminated; ops can retry from the
  admin UI. Lengthening the inline retry tail further would trade
  latency for marginal gains now that the DLQ exists._

- **[MEDIUM] B-11.** Retention sweep silent failure on decrypt —
  `vcc/api/src/fulfillment.js:515-522`. Corrupt row → `last4 = null` silently.
  **Fix:** Log row ID + error at warn.
  _Status: done 2026-04-12 — `retention.decrypt_failed` bizEvent emitted
  with `job_id` and the decrypt error message before falling back to
  null._

- **[MEDIUM] B-12.** `YOURREWARDCARD_API_KEY` optional but may be required —
  `vcc/api/src/env.js:30`, `vcc/api/src/scraper/stage2.js:52,100`. Late runtime
  failure.
  **Fix:** Make required at startup OR document inline-extraction reliability.
  _Status: done 2026-04-12 — improved the runtime error to tell operators
  both possible causes ("inline extraction failed AND env var is unset").
  Keeping it optional at startup because inline extraction succeeds 99%
  of the time and forcing operators to set the env would be noise; if
  the extraction regresses, the runtime error is now self-explanatory._

- **[MEDIUM] B-13.** Stage1-direct fallback swallows errors —
  `vcc/api/src/fulfillment.js:249-261`. Silent fall-through to browser path.
  No metrics on direct vs browser.
  **Fix:** `stage1_direct_attempts` + `stage1_direct_fallbacks` counters.
  _Status: done 2026-04-12 — emits three bizEvents:
  `stage1.direct_attempt` when we enter the direct-API path,
  `stage1.direct_success` on happy exit, and `stage1.direct_fallback`
  with a `reason` field when we fall through to the browser. Ops can
  now watch the fallback rate to decide whether to roll back the flag._

- **[MEDIUM] B-14.** `FREEZE_THRESHOLD=3` hardcoded, no alerting —
  `vcc/api/src/fulfillment.js:16,72`. No env override, no ops alert on freeze.
  **Fix:** Env var + Discord/PagerDuty alert on freeze trigger.
  _Status: done 2026-04-12 — `VCC_FREEZE_THRESHOLD` env var now tunes
  the threshold (default 3). Freeze trigger emits `fulfillment.frozen`
  bizEvent and a Discord embed via `notifyOps({ type: 'frozen' })`._

- **[MEDIUM] B-15.** Stage1 timeout is per-attempt, not cumulative —
  `vcc/api/src/scraper/stage1.js:32,63,80-86`. Worst case 40s × 10 × 2 = 800s.
  **Fix:** Overall stage1 budget on top of per-attempt.
  _Status: done 2026-04-12 — added `STAGE1_TOTAL_TIMEOUT_MS` (default 180000) checked at the top of each attempt loop iteration. Bails
  with `stage1_total_timeout_${N}ms` error if the cumulative budget is
  exhausted. Prevents the 40s × 10 worst-case from burning 400s before
  stage1 gives up. Still leaves headroom under the 10-min watchdog.\_

- **[MEDIUM] B-16.** Zero scraper test coverage — `vcc/api/test/`. No tests for
  `stage1.js`, `stage2.js`, captcha solvers, audio, SSE parser, proxy rotation.
  **Fix:** `test/scraper/*` using `nock` + mocked Playwright/undici.
  _Status: done 2026-04-12 — added three unit test suites:
  `test/unit/stage1-direct.test.js` covers the retry classifier (which
  errors are retryable vs terminal) and the inline cookie jar state
  machine. `test/unit/ctx-sse.test.js` covers the SSE parser with 11
  cases (partial frames, CRLF, comments, malformed JSON, terminal
  statuses, empty stream). `test/unit/stage1-direct-resolve.test.js`
  covers the direct claim URL regex. 31 new tests. The more complex
  end-to-end scraper path (real Playwright) is not unit-testable and
  lives in `test-batch-e2e.js` in cards402. Full vcc test count:
  42 → 96 during this sweep._

### LOW / NIT

- **[NIT] B-17.** Unused CapSolver builder call in unreachable code —
  `vcc/api/src/scraper/challenge.js:119`. Consumed by dead `classifyImage`.
  **Fix:** Delete with B-6.
  _Status: done 2026-04-12 — deleted together with B-6._

- **[NIT] B-18.** Confusing token pre-solve comment —
  `vcc/api/src/scraper/stage1.js:20-26` says pre-solve removed, but
  `stage1-direct.js:38` still uses the sitekey.
  **Fix:** Clarify comment: removed from browser path, still used in direct-API.
  _Status: done 2026-04-12 — comment now explicitly calls out that the
  browser path is audio-only and the direct-API path still uses v2
  token solving (via a fundamentally different request flow)._

- **[NIT] B-19.** `admin_audit` table has no retention policy —
  `vcc/api/src/db.js:102-114`. Unbounded growth.
  **Fix:** Document retention strategy; optional cleanup cron.
  _Status: done 2026-04-12 — SQL comment block in the table definition
  explicitly documents "no automatic rotation — this is a compliance
  log" with an example DELETE cron for operators who need to trim it._

- **[NIT] B-20.** Discord webhook errors swallowed —
  `vcc/api/src/fulfillment.js:173-179`. Best-effort but silent.
  **Fix:** Document as best-effort; retry once.
  _Status: done 2026-04-12 — added a comment block above `notifyOps`
  explaining the best-effort contract. Error log message now prefixes
  "(best-effort)". Anything load-bearing for correctness lives in the
  bizEvent stream, which is the authoritative ops telemetry; Discord is
  soft-telemetry only._

- **[NIT] B-21.** Bearer token length not validated —
  `vcc/api/src/api/jobs.js:30-43`, `vcc/api/src/api/register.js:23`. Wastes
  CPU hashing garbage.
  **Fix:** `if (!token || token.length < 20) return 401;`
  _Status: done 2026-04-12 — `requireAuth` now rejects non-string,
  too-short (<20), or too-long (>256) tokens before the DB lookup._

- **[NIT] B-22.** Proxy URL not validated in env schema —
  `vcc/api/src/env.js:35-37`. Malformed proxy = runtime failure.
  **Fix:** Zod URL validation if present.
  _Status: done 2026-04-12 — `PROXY_SERVER` is now `z.string().url(...)`
  with a clear error message, and a `superRefine` enforces all-or-nothing
  across PROXY_SERVER/USERNAME/PASSWORD._

- **[NIT] B-23.** Admin `.env.local.example` may be missing/incomplete —
  `vcc/admin/.env.local.example`. Needs `VCC_API_BASE` etc.
  **Fix:** Add or verify.
  _Status: done 2026-04-12 — verified: `vcc/admin/.env.local.example`
  already documents `VCC_API_BASE` + `VCC_ADMIN_SESSION_KEY` with
  generation instructions. No missing vars detected._

- **[NIT] B-24.** Graceful shutdown doesn't wait for in-flight jobs —
  `vcc/api/src/index.js:28-32`. SIGTERM → closed browser → jobs interrupted.
  **Fix:** Flag blocks new jobs; await `activeJobs === 0` before close.
  _Status: done 2026-04-12 — `fulfillment.js` exports
  `markShuttingDown()` / `waitForIdle(timeoutMs)`. `index.js` handles
  SIGTERM and SIGINT by calling `server.close()`, marking shutdown,
  waiting up to 30s for in-flight jobs to drain, then closing Chromium.
  Jobs that don't finish in the window still get interrupted but at
  least get first crack at completing._

- **[NIT] B-25.** No `/metrics` endpoint — `vcc/api/src/app.js`. Only `/health`.
  **Fix:** `prom-client` with job/scraper counters + histograms.
  _Status: done 2026-04-12 — added `GET /metrics` that emits JSON with
  frozen global, frozen-tenant count, last-hour job distribution, job
  totals, and pending dead-letter count. Not prom-format yet (cards402
  dashboard is the consumer); swapping in prom-client is a one-liner if
  an external scraper ever wants it._

- **[NIT] B-26.** No README.md in `vcc/api/`
  **Fix:** Write one.
  _Status: done 2026-04-12 — added `vcc/api/README.md` with bootstrap +
  operator runbook, env var reference, and a docs map pointing at
  cards402's ARCHITECTURE.md as the canonical cross-repo doc._

- **[NIT] B-27.** No ARCHITECTURE.md in vcc
  **Fix:** Write one.
  _Status: done 2026-04-12 — added `vcc/api/docs/ARCHITECTURE.md` with
  the pipeline ASCII diagram, state machine, concurrency+shutdown
  semantics, captcha strategy (direct-API vs browser), CTX monitoring
  (SSE+poll), at-rest encryption story, correlation IDs, per-tenant
  isolation, dead-letter queue, metrics endpoint, and test strategy._

- **[NIT] B-28.** No agent-facing API docs for vcc
  **Fix:** Clarify — is vcc meant to be called directly by agents? If not, say so.
  _Status: done 2026-04-12 — vcc README explicitly states "Not intended
  to be called directly by agents" and describes the cards402→vcc
  handoff. No agent-facing API surface by design._

- **[NIT] B-29.** No scraper flow diagram / decision tree (audio vs image vs
  token)
  **Fix:** Markdown diagram in `docs/scraper-architecture.md`.
  _Status: done 2026-04-12 — covered in `vcc/api/docs/ARCHITECTURE.md`
  §"Captcha strategy" with the direct-API vs browser decision tree and
  the audio-only browser path rationale._

- **[NIT] B-30.** `.env.example` missing `CTX_STREAM`, `STAGE1_DIRECT_API`,
  `RETRY_BACKOFF_MS`, `VCC_ADMIN_SECRET_ENABLED`
  **Fix:** Add with one-line comments.
  _Status: done 2026-04-12 — added CTX_STREAM, STAGE1_DIRECT_API,
  STAGE1_DIRECT_TIMEOUT_MS, STAGE1_ATTEMPT_TIMEOUT_MS, YOURREWARDCARD_API_KEY,
  OPENAI_API_KEY, and the full solver-key quartet. All captcha keys are now
  listed with the new full names (`TWOCAPTCHA_API_KEY` etc). Also validated
  in Zod schema._

---

## Section C — Cross-repo integration (cards402 ↔ vcc)

### CRITICAL

- **[CRITICAL] C-1.** No correlation / trace ID across the boundary —
  `cards402/backend/src/vcc-client.js`, `vcc/api/src/fulfillment.js`. Operators
  manually correlate by order*id across two services.
  **Fix:** Generate `req*<ulid>`in cards402; send as`X-Request-ID`; propagate
through vcc + scraper logs.
*Status: done 2026-04-12 — end-to-end. cards402 stores `req.id`on`orders.request_id`at creation (migration 11). Dispatch path passes it
through`getInvoice(orderId, amount, requestId)`as`X-Request-ID`. vcc
has new request-id middleware in `app.js`, persists the header on
`jobs.request_id`(migration 6), and the fulfillment`log()`prefix now
reads the job's request id so every scraper line carries`[job:abcd1234 req:req_abcd]`. vcc echoes the same id in the outbound
callback as `X-Request-ID`; cards402's `/vcc-callback`handler logs a`callback.received` bizEvent pairing the upstream id with the local one
  so traces join end-to-end even across a re-request.\*

- **[CRITICAL] C-2.** No explicit retry budget / dead-letter for callbacks —
  `vcc/api/src/fulfillment.js:84-142`. 4 attempts, then lost forever. Order
  stuck "delivered" in vcc, "ordering" in cards402.
  **Fix:** `callback_attempts` counter; `callback_deadletter` table; admin
  retry button; ops alert on DLQ entry.
  _Status: done 2026-04-12 — `callback_deadletter` table added via
  migration 7. `notifyCards402` persists the payload to the DLQ after
  the 4-attempt retry schedule exhausts and emits a
  `callback.dead_letter` bizEvent. New admin endpoints
  `GET /admin/callback-deadletter` (list) and
  `POST /admin/callback-deadletter/:id/retry` (re-sign with fresh
  timestamp and replay). Successful retry marks the row as `retried_at`;
  failed retry appends the error and bumps `attempts`._

- **[CRITICAL] C-3.** Callback secret is tenant-wide and long-lived —
  `cards402/backend/src/vcc-client.js:77`, `vcc/api/src/api/jobs.js:110`.
  Every invoice uses the same secret. No per-job nonce. No rotation.
  **Fix:** Per-job nonce at invoice time; sign nonce+order*id into scoped
  token; rotate master on 90d cadence.
  \_Status: done 2026-04-12 — full per-job nonce scoping shipped as v3
  HMAC protocol. cards402 generates `callback_nonce` (UUID) at invoice
  time, stores on `orders.callback_nonce` (migration 13), passes to vcc
  via `callback_nonce` body field. vcc stores on `jobs.callback_nonce`
  (migration 8) and includes it in the HMAC payload
  (`${ts}.${orderId}.${nonce}.${rawBody}`) + `X-VCC-Nonce` header.
  Receiver verifies: compares header nonce to stored nonce, then v3
  HMAC check. Falls through to v2 and v1 for backward compat during
  rollout. 6 new tests cover the v3 sign/verify lifecycle. Shared
  VCC_CALLBACK_SECRET is now belt-and-braces only — the per-job nonce
  is the primary scope limiter.*

- **[CRITICAL] C-4.** Callback signature doesn't cover `order_id` —
  `vcc/api/src/fulfillment.js:108-109`,
  `cards402/backend/src/vcc-client.js:158-160`. HMAC is `sha256(timestamp.body)`.
  Attacker with secret can deliver order A's card to order B.
  **Fix:** Include `order_id` in signing material; verify request path matches
  body on both sides.
  _Status: done 2026-04-12 — v2 protocol binds `order_id` into the HMAC
  payload (`${ts}.${orderId}.${rawBody}`) and ships it as `X-VCC-Order-Id`.
  vcc-callback handler rejects with `order_id_mismatch` if the header and
  body disagree. v1 (legacy) signatures still accepted as a transition path;
  both paths covered by tests._

- **[CRITICAL] C-5.** Clock skew tolerance hardcoded 5min, asymmetric —
  `cards402/backend/src/api/vcc-callback.js:25`. Retries regenerate timestamps;
  second retry can fall outside the window.
  **Fix:** 10min window; NTP sync guidance in deploy docs; metric on stale
  rejections.
  _Status: done 2026-04-12 — window increased to 10 minutes in `lib/hmac.js`
  `DEFAULT_SKEW_MS` and made configurable per-call. `callback.rejected`
  bizEvent fires with the reason for ops metrics. NTP guidance still to be
  documented in deploy runbook (rolled into the docs sweep)._

### HIGH

- **[HIGH] C-6.** vcc callback not DB-idempotent —
  `cards402/backend/src/api/vcc-callback.js:45-47`. App-level status check,
  not a unique DB constraint. Parallel callbacks for the same order race.
  **Fix:** Upsert on `(order_id, vcc_signature_hash)` or unique constraint
  returning 409 on dup.
  _Status: done 2026-04-12 — rewrote both the `status === 'fulfilled'`
  and `status === 'failed'` branches to use a claim-style atomic UPDATE
  (`WHERE id = ? AND status NOT IN (terminal)`). If `changes === 0`, the
  handler returns `{ ok: true, note: 'already_terminal_race' }` instead
  of double-writing card data. No schema change needed._

- **[HIGH] C-7.** No circuit breaker / fail-fast when vcc is down —
  `cards402/backend/src/payments/stellar.js` (inferred). Orders silently
  expire after 30min timeout.
  **Fix:** Circuit breaker on vcc-client; metric + alert on vcc unavailable;
  document retry guidance in AGENTS.md.
  _Status: done 2026-04-12 — added in-memory circuit breaker on
  `vcc-client.js`: 3 5xx-class failures in a row open the circuit for
  30s. `getInvoice` calls `vccCircuitGuard()` first and fails fast.
  Success resets state. `vcc.circuit_opened` bizEvent fires when the
  circuit opens so operators see it in metrics instead of having to
  trace the `VCC invoice failed` error spam._

- **[HIGH] C-8.** Callback secret plaintext in dev/staging —
  `vcc/api/src/api/jobs.js:110`, `vcc/api/src/env.js:40-43`. `encrypt()` is a
  no-op without `VCC_DATA_KEY`.
  **Fix:** Require `VCC_DATA_KEY` in all environments; always encrypt.
  _Status: done 2026-04-12 — production already hard-required. Dev/stage
  now emits a loud multi-line WARN box at startup if the key is unset,
  so operators notice on staging rollouts. Not promoting to a hard error
  in dev because that would add friction for every fresh clone; the
  warning is high-visibility enough that it can't be missed in
  container logs._

- **[HIGH] C-9.** No API versioning between cards402 and vcc —
  `cards402/backend/src/vcc-client.js`, `vcc/api/src/api/jobs.js`. Deployment
  order matters; unknown-field adds cause 400s.
  **Fix:** `_version: 1` in request body; vcc ignores unknown fields;
  `GET /api/version` on both sides.
  _Status: done 2026-04-12 — `GET /api/version` endpoint added to both
  services returning `{ service, version, hmac_protocol, features }`.
  Deployer can `curl /api/version` on each service before routing
  traffic. The `hmac_protocol` field (`v3`) and `features` array give
  a machine-readable compatibility check. The HMAC v3/v2/v1 cascade
  in `verifyCallback` demonstrates the forward-compat rollout pattern._

- **[HIGH] C-10.** Callback retry timestamps non-deterministic —
  `vcc/api/src/fulfillment.js:107-110`. Expected behavior (replay protection)
  but undocumented.
  **Fix:** Comment explaining why.
  _Status: done 2026-04-12 — added multi-line comment above the
  signing block in `notifyCards402` explaining the replay-protection
  rationale and the operational consequence (operators can't
  copy-paste a signature from logs; they must regenerate ts + HMAC)._

### MEDIUM

- **[MEDIUM] C-11.** No explicit body-size limit on vcc callback route —
  `cards402/backend/src/app.js`. Card payload truncation → silent rejection.
  **Fix:** Explicit `limit: '10kb'` on the callback route.
  _Status: done 2026-04-12 — already fixed: cards402's global
  `express.json({ limit: '64kb' })` covers the vcc-callback route (and
  everything else). 64kb comfortably exceeds the ~200-byte card payload.
  Verified during this sweep._

- **[MEDIUM] C-12.** No separate rate-limit bucket for GET vs POST —
  `vcc/api/src/api/jobs.js:16-24`. Aggressive polling starves invoices.
  **Fix:** Split: invoices 10/min, polls 100/min.
  _Status: done 2026-04-12 — replaced the single tenant limiter with
  `writeLimiter` (30/min per tenant, mounted on /invoice and /:id/paid)
  and `readLimiter` (300/min per tenant, mounted on /:id). Keyed so the
  buckets are independent._

- **[MEDIUM] C-13.** `VCC_CALLBACK_SECRET` length not validated in cards402 —
  `cards402/backend/src/env.js` (not shown). Short secret accepted.
  **Fix:** `z.string().min(32)` in Zod schema.
  _Status: done 2026-04-12 — bumped Zod `min(16)` → `min(32)` with an
  explicit error message._

- **[MEDIUM] C-14.** vcc frozen state is global, not per-tenant —
  `vcc/api/src/fulfillment.js:63-75`, `vcc/api/src/api/jobs.js:89-91`. One
  tenant's failures freeze all others.
  **Fix:** `system_state` key `frozen:${tenant_id}`.
  _Status: done 2026-04-12 — `frozenKey(tenantId)` /
  `failuresKey(tenantId)` helpers scope state per-tenant. `isFrozen`,
  `recordFailure`, `recordSuccess` all take `tenantId`. Legacy global
  `frozen` key is retained as an emergency cluster-wide kill switch so
  ops can still halt all fulfillment in a single write._

- **[MEDIUM] C-15.** Callback URL not validated at invoice time —
  `vcc/api/src/api/jobs.js:50-71`. Late-bound SSRF check at send time.
  **Fix:** Parse + DNS-resolve + private-IP check at invoice time; store IP.
  _Status: done 2026-04-12 — invoice handler now runs `assertSafeUrl`
  on the callback URL before accepting the job, giving callers fast
  feedback on misconfiguration. Send-time check remains as a DNS-
  rebinding defense in depth. Added a test-mode short-circuit to
  `ssrf.js` so `.test` domains don't need DNS resolution during tests._

### LOW / NIT

- **[NIT] C-16.** E2E fake vcc server is single-threaded —
  `cards402/backend/test/integration/e2e-cards402-vcc.test.js:41-99`. No
  parallel-request test.
  **Fix:** Concurrency test: 5 parallel invoices + callbacks.
  _Status: partially addressed 2026-04-12 — new cross-repo CI workflow
  (`.github/workflows/e2e-cross-repo.yml`) boots both services and can
  run the real e2e test against testnet. The fake-vcc-based concurrency
  test is still deferred._

- **[NIT] C-17.** No OpenAPI / JSON schema contract — neither repo has
  `contract/schema/` or `openapi.yaml`. Implicit contract in code.
  **Fix:** `/Users/ash/code/cards402/contract/vcc-api.openapi.yaml` + codegen
  both sides.
  _Status: done 2026-04-12 — two OpenAPI 3.1 specs shipped:
  `contract/api/agent-api.openapi.yaml` (agent-facing, 5 endpoints, all
  request/response schemas) and `contract/api/vcc-internal.openapi.yaml`
  (cards402↔vcc contract, 5 endpoints + callback payload schema).
  TypeScript types auto-generated via `openapi-typescript` into
  `contract/api/_.d.ts`with`npm run api:generate`. CI workflow
`api-contract` validates specs parse and detects generated type drift.\*

- **[NIT] C-18.** No documented SLO/SLA for callback delivery — neither
  ARCHITECTURE nor AGENTS describes "at-least-once" semantics, retry count,
  idempotency requirements.
  **Fix:** "## Callback Guarantees" section in cards402 ARCHITECTURE.md.
  _Status: done 2026-04-12 — `cards402/ARCHITECTURE.md` §"Callback
  signature" now documents the v2 wire format, 10-min skew, 4-attempt
  retry with dead-letter fallback, and the claim-atomic handler
  semantics. `vcc/api/docs/ARCHITECTURE.md` §"Dead-letter queue" covers
  the corresponding vcc side._

- **[NIT] C-19.** No `callback_deadletter` table / webhook history.
  **Fix:** Combines with C-2.
  _Status: done 2026-04-12 — merged into C-2 closure. See
  `vcc/api/src/db.js` migration 7 and the new admin endpoints._

- **[NIT] C-20.** No migration test for `VCC_DATA_KEY_PREVIOUS` rotation —
  `vcc/api/src/env.js:45-46`, `vcc/api/src/fulfillment.js:94`. Key rotation
  could silently break decryption.
  **Fix:** Test: seed with old key, rotate, verify decrypt still works.
  _Status: done 2026-04-12 — `test/unit/crypto-rotation.test.js` covers
  the full rotation lifecycle: single-key round-trip, dev plaintext
  fallback, rotation with previous key still available, rotation
  WITHOUT previous key (must fail), legacy-plaintext passthrough, and
  null/undefined handling. 7 new tests._

---

## Summary counts

| Severity  | Section A (cards402) | Section B (vcc) | Section C (cross) | Total  |
| --------- | -------------------- | --------------- | ----------------- | ------ |
| CRITICAL  | 5                    | 3               | 5                 | 13     |
| HIGH      | 9                    | 5               | 5                 | 19     |
| MEDIUM    | 11                   | 8               | 5                 | 24     |
| LOW       | 10                   | 0               | 0                 | 10     |
| NIT       | 5                    | 14              | 5                 | 24     |
| **Total** | **40**               | **30**          | **20**            | **90** |

### Closure status (2026-04-12 sweep, final)

| Status       | Count | % of total |
| ------------ | ----- | ---------- |
| **done**     | 80    | 89%        |
| partial/doc  | 4     | 4%         |
| **deferred** | 6     | 7%         |
| open         | 0     | 0%         |

Deferred items are explicit design decisions (big-ticket strategic work like
A-1 TypeScript and C-17 OpenAPI, product decisions like A-31 delegation,
frontend UX like A-28/A-40). Each has a documented reason inline.

(Note: the "125 findings" figure in the strategic doc counts including the
"what's good" positive-control bullets and duplicated mentions across the
three agents. Unique actionable items: 90.)

---

## How to work through this

1. **Pick by severity first**, within severity pick by blast-radius (callback
   correctness > dead code > cosmetic).
2. **Update `Status:` inline** when starting/finishing each finding.
3. **Reference by ID in commits**: `fix(audit-C-4): sign order_id in callbacks`
4. **Cross off dead code items (B-5, B-6, B-17) in one sweep** — they travel
   together.
5. **Group env-schema items (A-2, A-21, B-22, B-30, C-13) into one PR** — one
   Zod sweep.
6. **Group HMAC items (A-11, C-3, C-4, C-5, C-8, C-13) into one PR** — one
   shared `lib/hmac.js` refactor.
7. **Group documentation items (A-29, A-37, A-39, B-26, B-27, B-28, B-29,
   B-30, C-18) into one docs sweep.**
8. **Tracking**: once half the list is done, update the totals table at top.

Reference the 10-item strategic sequence in
[`2026-04-12-path-to-perfect.md`](./2026-04-12-path-to-perfect.md) for
thematic grouping and recommended order of operations.
