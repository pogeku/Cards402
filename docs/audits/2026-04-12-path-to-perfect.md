# 2026-04-12 — What's stopping this from being a perfect project

Synthesis of three parallel audit passes (cards402 backend/sdk/web/contract, vcc/api
fulfillment engine, cross-repo integration) framed as "what's blocking perfection
and what to do about it."

Scope: `/Users/ash/code/cards402` + `/Users/ash/code/vcc`. Focus is on
agent-understandability, code reuse, documentation, efficiency, connection
between the two services, and the usual quality/security/testing bar.

Context: runs on top of the 8-iteration captcha optimization (O1–O12), the
STAGE1_DIRECT_API fast path, and the SSE-based CTX fulfillment monitoring that
was added the same day as this audit.

---

## Headline

~90 unique actionable findings from the three audit passes. Distilled into 12
high-leverage themes. A 9-day sequence at the bottom would move the project
from "works in production" to "feels like a different project."

**Don't lose the long tail.** The full finding-by-finding checklist lives in
[`2026-04-12-full-findings.md`](./2026-04-12-full-findings.md) with stable IDs
(`A-1`, `B-5`, `C-4`, etc.) you can reference in commit messages. Work through
it as a checklist and update each finding's `Status:` line inline.

---

## 1. Agent experience is the biggest gap

The whole pitch is "agents order cards via an API" but the agent-facing
surface is underweight.

- **No MCP server for cards402**. `sdk/src/mcp.ts` exists but is not wired for
  `claude mcp add`. An agent using Claude Code should be able to
  `claude mcp add cards402` and immediately have `create_order`, `get_order`,
  `list_orders` tools. Closest thing to product-market fit for this project.
- **No canonical agent quickstart**. `AGENTS.md` exists but is architectural.
  Agents need a 30-line "order your first card in 60 seconds" with API-key
  setup, code sample, and the happy-path response shape.
- **Error taxonomy is undocumented**. Agents can't program against errors
  like `amount_below_minimum`, `card_brand_unsupported`,
  `policy_requires_approval`, `vcc_temporarily_unavailable` if they don't
  exist as a stable enum with docs.
- **Sample code is missing**. No `examples/node-agent/`, `examples/python-agent/`,
  `examples/langchain-tool/` with working integrations.
- **Status webhook spec not in one place**. Webhook payload shape lives in code.
  Agents hooking into delivery need a schema.

**Fix:** Make `cards402-mcp` a real MCP server, ship it as `npm install -g
cards402-mcp`, add 3 working example agents. This single change is worth more
than every backend fix combined.

## 2. Correlation ID is missing end-to-end

There is no `X-Request-ID` propagated from cards402 → vcc → scraper →
callback. Operators must manually correlate by order_id across two services'
logs. Adding a correlation header is ~20 lines of middleware and unlocks
everything observability-wise.

**Fix:** cards402 generates `req_<ulid>` per API request, stamps it on the
order, sends it in every vcc call as `X-Request-ID`, and the scraper `tlog`
prefixes it in every line.

## 3. The callback contract is weaker than it should be

- **Signature doesn't cover `order_id`**. HMAC is `SHA256(timestamp.body)` — an
  attacker with the callback secret could deliver order A's card to order B.
  (`vcc/api/src/fulfillment.js:108`, `cards402/backend/src/api/vcc-callback.js:158`)
- **Callback secret is tenant-wide and plaintext in dev**. No per-job nonce, no
  rotation story.
- **No dead-letter queue**. 4 retries (`[0, 5s, 30s, 2m]`) then silent loss.
  If cards402 is down for 3+ min mid-fulfillment, the card is minted in vcc and
  never reaches the agent. (`vcc/api/src/fulfillment.js:84-142`)

**Fix:** Include `order_id` in signing material. Generate per-job nonces at
invoice time. Build a `callback_deadletter` table + admin "retry delivery"
button. ~100 lines total, eliminates a whole class of silent failures.

## 4. Two stage1 implementations live side-by-side

`stage1.js` (Chromium + audio, ~8–200s) and `stage1-direct.js` (pure fetch,
~10–70s) are both wired into fulfillment with direct-API as a flag. Direct
path is a clear win (batch 8 proved it) but leaving both means:

- ~1500 lines of Chromium scraping code that's only used as "fallback"
- Two captcha-solver code paths to maintain
- Confusion for agents reading the repo

**Fix:** Commit. If direct-API is good enough, delete `stage1.js`,
`scraper/browser.js`, the audio/challenge/fingerprints modules, the patchright
dependency. If you want a fallback, keep browser path _disabled by default_
and require explicit opt-in per job.

## 5. Backend is JavaScript, SDK is TypeScript — they disagree

The SDK has strict TypeScript. cards402 backend is plain JS with JSDoc.
admin/ is TypeScript. vcc/api is plain JS. Result:

- Contract drift: backend field renames won't fail SDK tests
- 4000+ lines of money-moving code with no type checking
- Agents using the SDK see one shape; backend actually returns another

**Fix:** Pick one of three moves (don't mix):
(a) Migrate cards402/backend + vcc/api to TypeScript strict (~2 weeks)
(b) Enforce the contract via OpenAPI schema in `contract/openapi.yaml` and
codegen types for both backend and SDK (~2 days; best ROI)
(c) Enforce JSDoc `@typedef` + `tsc --checkJs` in CI (~half day; minimum viable)

Option (b) is the right call. Gives agents a machine-readable contract too.

## 6. Dead code pollution in scrapers

Per vcc audit:

- `raceSolversV3`, `raceSolversHCaptcha` exported but never called
  (`vcc/api/src/scraper/captcha.js:143`)
- `getQuestionText`, `getGridSize`, `screenshotGrid`, `classifyImage`,
  `clickTiles`, `ensureChallengeOnTop`, `checkResult` all dead in
  `scraper/challenge.js` — comment literally says "removed in O9" but the code
  is still there
- ~200 LOC of pure debt

**Fix:** Delete. Git history is the archive.

## 7. Admin dashboards are missing operator-critical views

What an operator actually wants to see (and currently can't):

- **Watcher lag**: how many ledgers behind mainnet
- **vcc job state distribution**: queued/running/failed/delivered in last hour
- **Webhook delivery success rate**: am I losing callbacks?
- **Captcha vendor win rates**: is 2captcha degrading?
- **Proxy success rate per session**: are oxylabs IPs rotten?
- **Card retention status**: how many PANs still in DB past retention?
- **CTX fulfillment time histogram**: is SSE actually helping?
- **Dead-letter queue** (once #3 exists)
- **Admin action audit log**: who approved which order, when

Also missing on cards402 admin: pagination state in URL, loading states on
buttons, CSV streaming for large exports, per-dashboard filter.

**Fix:** One `/admin/health` endpoint per service returning all of the above as
JSON, then a single "System Health" page in the admin UI. ~1 day.

## 8. Documentation is stale and scattered

- `vcc/api/` has no README and no ARCHITECTURE.md
- `cards402/ARCHITECTURE.md` is excellent but doesn't reference vcc accurately
  for current code
- `.env.example` files miss newer flags (`CTX_STREAM`, `STAGE1_DIRECT_API`,
  `VCC_CARD_RETENTION_DAYS`, `STAGE1_ATTEMPT_TIMEOUT_MS`)
- No CHANGELOG in either repo
- `AGENTS.md` exists in cards402 but no agent-facing examples
- Contract upgrade runbook missing — docs say "burn the admin key" but not
  where the key lives

**Fix:** One canonical `docs/` dir on the cards402 side that covers both
services. Single source of truth. Kill vcc README nonexistence. Every env var
lives in `.env.example` with a one-line comment. CHANGELOG per repo per release.

## 9. Duplicated logic across layers

- Stats queries duplicated in `api/dashboard.js` and `api/admin.js` with
  slight filter differences — worst kind of duplication
- `payViaContract` and `payVCC` both exported from SDK (back-compat alias)
- HMAC verification not extracted into shared `lib/hmac.js`
- Proxy config building logic in two places
- Cookie jar reimplemented in `stage1-direct.js`

**Fix:** Extract `lib/stats.js`, `lib/hmac.js`, `lib/proxy.js` as small shared
modules. If you can't share across repos, at least share within each.

## 10. No scraper tests — the most failure-prone code has 0% coverage

vcc has tests for API routes but zero for `stage1.js`, `stage2.js`, captcha
solvers, audio transcription, SSE parser, proxy rotation. Exactly the modules
that break in production.

**Fix:** Add `test/scraper/stage1-direct.test.js` using `nock` to mock
`claims.storedvalue.com`. Mock happy path + each error branch. Mock SSE with
a ReadableStream. ~1 day, catches regressions forever.

## 11. Observability is ad-hoc

- No `/metrics` endpoint on either service
- Logs go to stdout but no structured JSON schema
- Payment events logged via `console.log` in `xlm-sender.js` (unredacted
  Stellar txids — `backend/src/payments/xlm-sender.js:87,89`)
- `bizEvent` exists on cards402 but not plumbed through vcc
- No ops alerting on freeze / dead-letter / watcher lag

**Fix:** Ship `pino` or the existing structured logger everywhere. Add
`/metrics` (prom-client) with the counters from #7. Pipe freeze/dead-letter
alerts to the Discord webhook that already exists.

## 12. CI is repo-local, not cross-repo

Each repo's CI runs its own tests. There's no combined pipeline that:

- Spins up both services
- Runs `test-batch-e2e.js` against Stellar testnet
- Validates the contract between them

The integration test exists (`e2e-cards402-vcc.test.js`) but uses a fake vcc
server. Real drift slips through.

**Fix:** GitHub Actions workflow in cards402 that checks out vcc as a sibling,
boots both in containers, runs e2e against testnet.

---

## Recommended sequence (the 80/20)

Each item is independently shippable. Each builds on the previous.

| #   | Task                                                                 | Effort | Impact                                              |
| --- | -------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| 1   | Kill stage1 browser path + dead captcha code                         | 0.5d   | −1500 LOC, one path to reason about                 |
| 2   | Add correlation IDs end-to-end                                       | 0.5d   | Debuggable in minutes instead of hours              |
| 3   | OpenAPI contract + codegen for SDK/backend                           | 2d     | Agents get machine-readable types, drift impossible |
| 4   | Build `cards402-mcp` server properly, publish to npm                 | 1d     | Agent adoption unblocked                            |
| 5   | Sign `order_id` in callbacks + per-job nonces + dead-letter table    | 1d     | Eliminates silent delivery loss                     |
| 6   | `/admin/health` dashboard with 8 operator-critical views             | 1d     | Ops finally has situational awareness               |
| 7   | Scraper tests (stage1-direct, SSE parser, captcha race)              | 1d     | Regressions caught before shipping                  |
| 8   | Consolidate docs: one `docs/`, env vars complete, CHANGELOG per repo | 0.5d   | Agents + operators onboard without reading code     |
| 9   | Cross-repo e2e CI on real testnet                                    | 1d     | Deploy confidence                                   |
| 10  | 3 working example agents in `examples/`                              | 0.5d   | Obvious adoption path                               |

**Total: ~9 engineer-days.**

---

## What's already great (don't touch)

- Soroban watcher with persisted cursor — robust, crash-safe, correct
- HMAC + SSRF protection on webhooks (agent → cards402 direction)
- Card encryption at rest (AES-256-GCM)
- Idempotency-Key support on order creation
- Circuit breaker on fulfillment failures
- SSE streaming just added (worked first try, verified in batch 9)
- Direct-API stage1 path (batch 8 proved the concept at mean 51.87s)
- Schema migrations
- SDK strict TypeScript
- `test-batch-e2e.js` harness
- ARCHITECTURE.md on cards402 is excellent
- CI has semgrep + gitleaks

---

## Individual high-severity findings worth keeping visible

### cards402 backend

1. **Backend is plain JS, no `typecheck` script** (`backend/package.json:10`)
2. **SMTP vars not in env schema** (`backend/src/env.js`) — silent email
   failure possible
3. **`xlm-sender.js:87,89` uses console.log** — unredacted Stellar txids
4. **Webhook has no per-URL rate limit / circuit breaker**
   (`backend/src/fulfillment.js:19-52`) — one slow agent webhook blocks the
   pipeline
5. **CSV export unbounded** (`backend/src/api/admin.js:65-71`) — OOM risk
6. **Policy after-hours check silently skips on malformed JSON**
   (`backend/src/policy.js:67`)
7. **Recovery job calls vcc without timeout** (`backend/src/jobs.js:119-130`)
8. **Admin dashboard has no audit log** — who approved what when
9. **`GET /v1/orders` has no date filter** (`backend/src/api/orders.js:288-293`)
10. **MCP server version hardcoded** (`sdk/src/mcp.ts:36`)

### vcc/api

1. **CTX access/refresh tokens stored plaintext** in `system_state`
   (`vcc/api/src/ctx/client.js:14-16`) — should use `VCC_DATA_KEY`
2. **POST `/api/register` lacks rate limit** — anyone can spam tenants
3. **Whisper error response may leak `OPENAI_API_KEY`**
   (`vcc/api/src/scraper/audio.js:34`) — redact external API errors
4. **Admin routes have no per-token rate limit**
   (`vcc/api/src/api/admin.js:1-258`)
5. **`raceSolversV3`/`raceSolversHCaptcha` dead** (`scraper/captcha.js:143`)
6. **Image classification dead** (`scraper/challenge.js:48-243` ~200 LOC)
7. **vcc frozen state is global, not per-tenant**
   (`vcc/api/src/fulfillment.js:63-75`) — one tenant freezes all
8. **No `/metrics` endpoint** — only `/health`
9. **SIGTERM doesn't wait for in-flight jobs** (`vcc/api/src/index.js:28-32`)
10. **Graceful shutdown interrupts orders mid-fulfillment**
11. **`YOURREWARDCARD_API_KEY` late failure** (`vcc/api/src/scraper/stage2.js:100`)
    — validate at startup

### Cross-repo integration

1. **No correlation/trace ID** across cards402↔vcc
2. **Callback signature doesn't cover `order_id`** — replay to different order
3. **Callback secret tenant-wide, not per-job**
4. **No dead-letter queue for callbacks**
5. **Clock skew tolerance hardcoded 5min, asymmetric**
6. **Callback not idempotent at DB level** (app-level only)
7. **No circuit breaker on vcc-client calls from cards402**
8. **No API versioning** — deployment-order sensitive
9. **No shared OpenAPI/JSON schema**
10. **Fake vcc in E2E test doesn't cover concurrency**

---

## State the day of this audit

- Batch 8: 10/10, mean 51.87s (direct-API + 3-solver race baseline)
- Batch 9: 10/10, mean 52.43s, max 124s (SSE added, direct-API no retry bug
  → one outlier on bad proxy)
- Retry fix applied to `stage1-direct.js` (`RETRYABLE_DIRECT_ERRORS` loop)
- Batch 10: 0/10 — unrelated, agent wallet out of XLM (0.877 vs required 1.0)
- Batch 11 pending wallet refund to validate retry fix

Agent wallet to refund:
`GC4GNR6EULNVJEBF6XZV47EXTVMDZHBKKFVUSNQTSX2MPV2SOIL6HCOM`

---

## Next action

Pick an item from the sequence table and start. Recommendation: #1 (delete
dead code) then #4 (MCP server). #1 makes everything else easier to reason
about; #4 is the highest-leverage agent win.
