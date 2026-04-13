# cards402 Adversarial Audit

Date: 2026-04-13
Status: Completed initial comprehensive pass; additional passes reached diminishing returns
Audited repos:

- `cards402` at `/Users/ash/code/cards402`
- `vcc` at `/Users/ash/code/vcc`

## Scope

This audit treats `cards402` and `vcc` as a single payment and fulfillment
system.

In-scope components reviewed so far:

- `cards402/backend`
- `cards402/contract`
- `cards402/sdk`
- `cards402/web`
- `vcc/api`
- `vcc/admin`
- cross-system contracts: `cards402 -> vcc`, `vcc -> cards402`, Stellar/Soroban,
  CTX, OWS wallet flows

Primary objectives:

- find exploitable security issues
- find correctness failures in payment, fulfillment, callback, refund, and
  custody paths
- assess data handling for PAN/CVV/expiry, API keys, callback secrets, and
  treasury credentials
- assess operational resilience, recovery, and observability

## Method

Current pass order:

1. Threat boundaries and end-to-end flow
2. Cross-system payment and callback path
3. Cards/data handling
4. Backend and fulfillment engine internals
5. Contract, SDK/OWS, web/admin, CI/tests/docs

Evidence is being collected directly from implementation and repository docs.
This file will be updated during execution rather than written as a final
summary after the fact.

## System model

Observed trust boundaries:

- Agent -> `cards402` API
- Agent wallet / OWS vault -> Soroban receiver contract
- Soroban receiver contract -> `cards402` watcher
- `cards402` -> `vcc` invoice and job APIs
- `cards402` treasury -> CTX payment URL
- `vcc` -> CTX APIs / SSE / scraper targets
- `vcc` -> captcha vendors / proxy providers
- `vcc` -> `cards402` callback endpoint
- operators -> `cards402` dashboard/admin
- operators -> `vcc` admin
- both repos -> SQLite files, CI, environment secrets

High-value assets:

- full card PAN/CVV/expiry
- `STELLAR_XLM_SECRET`
- OWS wallets and vaults
- cards402 API keys
- VCC tenant token
- callback signing secrets and nonces
- CTX access/refresh tokens
- admin/session tokens

## Initial findings

### 0. cards402 appears to fulfill orders without validating the on-chain payment amount

Severity: Critical

Why this matters:

- The Soroban contract accepts any positive `amount`.
- The watcher decodes the actual event amount and passes it into
  `handlePayment(...)`.
- `handlePayment(...)` does not compare the paid amount with the order's
  expected quote before moving the order to `ordering` and spending treasury
  funds on fulfillment.
- For USDC payments the decoded `amountUsdc` is explicitly ignored.
- For XLM payments the received amount is recorded only for refund bookkeeping,
  while fulfillment still proceeds against the full order face value.

Evidence:

- order creation stores the expected quoted amount in the order and the payment
  instructions:
  [backend/src/api/orders.js](/Users/ash/code/cards402/backend/src/api/orders.js:347)
- the watcher reads the actual event amount from chain and forwards it:
  [backend/src/payments/stellar.js](/Users/ash/code/cards402/backend/src/payments/stellar.js:131)
- `handlePayment(...)` discards `amountUsdc` (`amountUsdc: _amountUsdc`) and
  performs no amount check before claiming the order:
  [backend/src/payment-handler.js](/Users/ash/code/cards402/backend/src/payment-handler.js:19)
- it then asks `vcc` for an invoice using `order.amount_usdc` and pays CTX
  with treasury funds based on the order face value, not the actual on-chain
  amount:
  [backend/src/payment-handler.js](/Users/ash/code/cards402/backend/src/payment-handler.js:47)
- there is even an `excess_usdc` migration, but no observed implementation
  using it:
  [backend/src/db.js](/Users/ash/code/cards402/backend/src/db.js:251)

Exploit sketch:

- create a `$100` order
- call `pay_usdc` or `pay_xlm` on the receiver contract with the same `order_id`
  and a tiny positive amount
- the watcher sees a valid payment event and credits the order
- cards402 spends treasury funds to fulfill the full order

Impact:

- direct treasury loss
- attacker can buy cards for less than quoted price
- refund logic may also return only the tiny paid amount for XLM paths while
  the system already spent full value on fulfillment

Recommended fix direction:

- reject any payment event whose amount does not exactly match the expected
  quote for the selected asset
- store expected quoted amounts per order and compare before any state
  transition to `ordering`
- route mismatches to `unmatched_payments` instead of fulfillment

### 1. cards402 stores delivered PAN/CVV/expiry directly in its own primary database

Severity: High

Why this matters:

- `vcc` explicitly encrypts card data at rest and purges it on retention.
- `cards402` then re-materializes the same PAN/CVV/expiry into its own `orders`
  table without equivalent encryption enforcement.
- A database leak, backup leak, support snapshot, or local filesystem compromise
  on the `cards402` side exposes full card data even if `vcc` is hardened.

Evidence:

- `cards402` schema stores raw card columns directly in `orders`:
  [backend/src/db.js](/Users/ash/code/cards402/backend/src/db.js:12)
- `vcc` callback writes PAN/CVV/expiry directly into `orders`:
  [backend/src/api/vcc-callback.js](/Users/ash/code/cards402/backend/src/api/vcc-callback.js:113)
- stuck-order recovery also writes returned PAN/CVV/expiry directly into
  `orders`:
  [backend/src/jobs.js](/Users/ash/code/cards402/backend/src/jobs.js:303)
- admin status explicitly reports how many `orders` still hold
  `card_number IS NOT NULL`, confirming the system expects card data to remain
  resident in cards402 storage:
  [backend/src/api/admin.js](/Users/ash/code/cards402/backend/src/api/admin.js:276)
- by contrast, `vcc` encrypts card data with AES-256-GCM:
  [api/src/lib/crypto.js](/Users/ash/code/vcc/api/src/lib/crypto.js:1)
- and purges PAN/CVV/expiry on a retention sweep:
  [api/src/fulfillment.js](/Users/ash/code/vcc/api/src/fulfillment.js:561)

Impact:

- widens the blast radius from one fulfillment store (`vcc`) to two databases
- undermines the retention and encryption work done in `vcc`
- increases incident scope for DB dumps, local workstation compromise, backup
  compromise, and operational access

Recommended fix direction:

- stop persisting full PAN/CVV/expiry in `cards402` by default
- if temporary storage is unavoidable, encrypt it at rest with a dedicated key
  and add a retention sweep mirroring `vcc`
- prefer a retrieval model that minimizes duplicate residence of card data

### 2. cards402 uses one shared callback secret for every vcc job

Severity: Medium

Why this matters:

- The implementation sends `process.env.VCC_CALLBACK_SECRET` as the
  `callback_secret` for every invoice sent to `vcc`.
- `vcc` stores `callback_secret` per job, but the effective secret value is
  global from the cards402 side.
- Nonces reduce forgery risk, but a single secret leak still creates a
  cross-order shared-secret blast radius and weakens compartmentalization.
- This also conflicts with the architecture and security narrative in `vcc`,
  which treats `callback_secret` as per-job material.

Evidence:

- cards402 invoice dispatch uses one env secret for every job:
  [backend/src/vcc-client.js](/Users/ash/code/cards402/backend/src/vcc-client.js:117)
- the nonce is per-order, but the secret is not:
  [backend/src/payment-handler.js](/Users/ash/code/cards402/backend/src/payment-handler.js:47)
- `vcc` invoice endpoint accepts a caller-supplied `callback_secret` and stores
  it per job:
  [api/src/api/jobs.js](/Users/ash/code/vcc/api/src/api/jobs.js:66)
- `vcc` encrypts the per-job `callback_secret`, indicating the intended model
  is job-scoped rather than globally shared:
  [api/src/lib/crypto.js](/Users/ash/code/vcc/api/src/lib/crypto.js:1)

Impact:

- one leaked cards402 callback secret affects all past and future jobs that
  rely on that shared secret, bounded only by nonce knowledge and protocol
  version behavior
- reduces compartmentalization between orders and tenants
- makes the `vcc` per-job secret storage less meaningful than it appears

Recommended fix direction:

- generate a fresh random callback secret per order in `cards402`
- store only the order-scoped secret reference needed for verification
- remove any remaining reliance on a single global `VCC_CALLBACK_SECRET` for
  job authentication

### 3. OTP verification endpoint lacks brute-force throttling

Severity: Medium

Why this matters:

- Login codes are 6 digits, so the search space is only 1,000,000 values.
- `POST /auth/login` limits code issuance, but `POST /auth/verify` has no
  attempt throttling, IP throttling, per-email lockout, or failed-attempt
  counter.
- The same verification path creates user sessions and, on a fresh instance,
  the first successful verifier becomes `owner`.

Evidence:

- 6-digit codes are generated in-process:
  [backend/src/api/auth.js](/Users/ash/code/cards402/backend/src/api/auth.js:31)
- `/auth/login` limits outstanding codes per email:
  [backend/src/api/auth.js](/Users/ash/code/cards402/backend/src/api/auth.js:63)
- `/auth/verify` is implemented as a plain route handler with no rate limiter
  wrapper and no failed-attempt accounting:
  [backend/src/api/auth.js](/Users/ash/code/cards402/backend/src/api/auth.js:119)
- a successful verification directly creates a session token and can create the
  first `owner` user:
  [backend/src/api/auth.js](/Users/ash/code/cards402/backend/src/api/auth.js:149)

Impact:

- enables online brute-force against email OTPs
- increases risk for owner bootstrap and privileged dashboard access
- allows distributed guessing campaigns against known operator email addresses

Recommended fix direction:

- add per-IP and per-email rate limits to `/auth/verify`
- add failed-attempt counters and temporary lockouts on `auth_codes`
- consider longer or alphanumeric OTPs for sensitive operator auth

### 4. Full card data is readable through the internal cards402 API by any `@cards402.com` account

Severity: Medium

Why this matters:

- The `/internal/*` surface is not owner-scoped.
- Any authenticated user whose email ends with `@cards402.com`, or is listed in
  `INTERNAL_EMAILS`, passes `requireInternal`.
- That role can call `/internal/orders` and receive full `card_number`,
  `card_cvv`, and `card_expiry` for all orders.

Evidence:

- internal routes are intended to expose card data:
  [backend/src/api/internal.js](/Users/ash/code/cards402/backend/src/api/internal.js:2)
- `/internal/orders` returns full PAN/CVV/expiry:
  [backend/src/api/internal.js](/Users/ash/code/cards402/backend/src/api/internal.js:18)
- `requireInternal` authorizes any `@cards402.com` email or allowlisted email:
  [backend/src/middleware/requireInternal.js](/Users/ash/code/cards402/backend/src/middleware/requireInternal.js:15)
- regular verified users are created with role `user`; internal access is not
  tied to the stricter owner role:
  [backend/src/api/auth.js](/Users/ash/code/cards402/backend/src/api/auth.js:149)

Impact:

- compromises of ordinary corporate mailboxes can become card-data exposure
- widens PAN/CVV/expiry access beyond a narrowly-scoped ops cohort
- increases insider and phishing blast radius

Recommended fix direction:

- require a dedicated privileged role for raw card access
- split “internal observability” from “sensitive card retrieval”
- add step-up auth and explicit audit logging for raw card reveals

### 5. Agent claim payloads can be stored plaintext if `CARDS402_SECRET_BOX_KEY` is unset

Severity: High

Why this matters:

- The agent onboarding flow intentionally exists to avoid putting raw API keys
  into chat transcripts.
- That protection collapses if the backend stores `sealed_payload` as plaintext
  when `CARDS402_SECRET_BOX_KEY` is unset.
- The stored payload contains the raw `cards402_...` API key and webhook secret.

Evidence:

- the secret box explicitly becomes a no-op with no key configured:
  [backend/src/lib/secret-box.js](/Users/ash/code/cards402/backend/src/lib/secret-box.js:13)
- `secretBox.seal(...)` is used when minting agent claim rows:
  [backend/src/api/dashboard.js](/Users/ash/code/cards402/backend/src/api/dashboard.js:357)
- claim rows are documented as “sealed”, but there is no startup env
  validation requiring `CARDS402_SECRET_BOX_KEY`:
  [backend/src/db.js](/Users/ash/code/cards402/backend/src/db.js:508)
- when redeeming a claim, plaintext payloads are accepted transparently because
  `open()` passes through non-`enc:` values:
  [backend/src/lib/secret-box.js](/Users/ash/code/cards402/backend/src/lib/secret-box.js:43)

Impact:

- DB dumps can expose raw API keys and webhook secrets for not-yet-redeemed
  agents
- undermines the stated purpose of the claim-code onboarding design
- expands recovery scope from “revoke one claim code” to “rotate real API keys”

Recommended fix direction:

- require `CARDS402_SECRET_BOX_KEY` at startup in production
- fail claim creation if no secret-box key is configured
- consider re-sealing or expiring any legacy plaintext `agent_claims` rows

### 6. Callback verifier still accepts legacy v1 signatures

Severity: Medium

Why this matters:

- Both `cards402` and `vcc` now implement v3 signatures with `orderId` and
  `nonce`, and `cards402` always sends a callback nonce when creating jobs.
- Despite that, both verifiers still accept the old v1 format
  `${timestamp}.${rawBody}` with no `orderId` binding.
- Keeping the legacy branch expands the acceptance surface and weakens the
  protocol hardening work already done in v2/v3.

Evidence:

- `cards402` shared verifier still accepts v1:
  [backend/src/lib/hmac.js](/Users/ash/code/cards402/backend/src/lib/hmac.js:133)
- `vcc` shared verifier still accepts v1:
  [api/src/lib/hmac.js](/Users/ash/code/vcc/api/src/lib/hmac.js:128)
- `cards402` now stores and uses a per-order callback nonce:
  [backend/src/db.js](/Users/ash/code/cards402/backend/src/db.js:442)
- `cards402` always sends `callback_nonce` when requesting an invoice:
  [backend/src/vcc-client.js](/Users/ash/code/cards402/backend/src/vcc-client.js:122)

Impact:

- if the callback secret leaks, v1 signatures allow forging requests without
  `orderId` binding or nonce binding
- makes it harder to reason about replay and downgrade resistance

Recommended fix direction:

- remove v1 acceptance once both deployed services are confirmed on v3
- if compatibility is still required temporarily, gate legacy acceptance behind
  an explicit rollout flag and telemetry, not permanent fallback logic

### 7. `unmatched_payments` appears unimplemented despite being documented as a recovery path

Severity: High

Why this matters:

- The architecture says unmatched or late payments should be recorded for
  manual or automated refund.
- The schema and admin/internal views expose an `unmatched_payments` table.
- But the live payment handler simply returns when `order_id` is unknown or not
  in `pending_payment`, with no insert and no refund scheduling.
- That means typoed, duplicate, or post-expiry payments can land in treasury
  without structured tracking or a built-in refund path.

Evidence:

- docs say unmatched payments are written to `unmatched_payments`:
  [ARCHITECTURE.md](/Users/ash/code/cards402/ARCHITECTURE.md:135)
- schema defines `unmatched_payments`:
  [backend/src/db.js](/Users/ash/code/cards402/backend/src/db.js:79)
- admin/internal APIs expose it for review:
  [backend/src/api/admin.js](/Users/ash/code/cards402/backend/src/api/admin.js:1032)
  [backend/src/api/internal.js](/Users/ash/code/cards402/backend/src/api/internal.js:47)
- actual payment handler exits early on unknown/non-pending orders and does not
  write any unmatched-payment row:
  [backend/src/payment-handler.js](/Users/ash/code/cards402/backend/src/payment-handler.js:27)
- repository search found no observed insert/update path into
  `unmatched_payments`, only reads:
  `rg "unmatched_payments" backend/src`

Impact:

- on-chain funds can become operator debt with no durable record
- manual refund operations depend on external logs or ad hoc reconstruction
- reduces incident response quality for payment mistakes and adversarial tests

Recommended fix direction:

- insert unmatched or invalid payment events into `unmatched_payments`
  immediately from the watcher/handler path
- include txid, sender, asset, amount, claimed `order_id`, and rejection reason
- add a reconciler for refunding unmatched rows safely

### 8. Lost-callback recovery path appears broken across `cards402` and `vcc`

Severity: High

Why this matters:

- `cards402` has a reconciler intended to recover orders when `vcc` delivered a
  card but the callback was lost.
- That reconciler expects `GET /api/jobs/:id` from `vcc` to return
  `card_number`, `card_cvv`, and `card_expiry`.
- `vcc` deliberately strips those fields from the job-status response.
- As implemented, the “recover delivered card via VCC poll” branch will never
  fire against the real `vcc` API.

Evidence:

- cards402 recovery logic requires `vccJob.card_number`:
  [backend/src/jobs.js](/Users/ash/code/cards402/backend/src/jobs.js:300)
- `vcc` strips `card_number`, `card_cvv`, `card_expiry`, and `callback_secret`
  from `GET /api/jobs/:id`:
  [api/src/api/jobs.js](/Users/ash/code/vcc/api/src/api/jobs.js:183)
- cards402 architecture presents the mid-flight steps as recoverable by the
  reconciler in `jobs.js`:
  [ARCHITECTURE.md](/Users/ash/code/cards402/ARCHITECTURE.md:118)
- `vcc` docs instead emphasize callback retries and dead-letter handling as the
  result-delivery recovery path:
  [api/docs/ARCHITECTURE.md](/Users/ash/code/vcc/api/docs/ARCHITECTURE.md:135)

Impact:

- if `vcc` delivers a card and the callback path fails permanently, cards402's
  polling fallback may leave the order stuck instead of recovering delivery
- increases operator intervention burden and raises the chance of duplicate
  refunds or stranded delivered cards
- cross-repo contract drift makes the documented recovery story unreliable

Recommended fix direction:

- choose one recovery contract and make both repos implement it consistently
- either expose a privileged recovery endpoint for delivered-card retrieval, or
  remove the impossible polling branch from cards402 and rely solely on the
  callback dead-letter flow

### 9. USDC recovery path can retry CTX payment as raw XLM and bypass the original spend cap

Severity: High

Why this matters:

- The first-pass fulfillment path correctly distinguishes XLM-paid vs
  USDC-paid orders and, for USDC, pays CTX with `payCtxOrder(paymentUrl,
{ paymentAsset, maxUsdc })`.
- The ordering reconciler does not preserve those arguments when retrying the
  payment step.
- On a stuck USDC order with `xlm_sent_at IS NULL`, the retry path calls
  `payCtxOrder(paymentUrl)` with no asset metadata or `maxUsdc`.
- `payCtxOrder(...)` interprets missing `paymentAsset` as the raw-XLM branch,
  so the retry can spend treasury XLM directly instead of using the user's
  paid USDC and the original `sendMax` guard.

Evidence:

- initial fulfillment passes `paymentAsset` and `maxUsdc`:
  [backend/src/payment-handler.js](/Users/ash/code/cards402/backend/src/payment-handler.js:62)
- the ordering reconciler retries the CTX payment step without either value:
  [backend/src/jobs.js](/Users/ash/code/cards402/backend/src/jobs.js:236)
  [backend/src/jobs.js](/Users/ash/code/cards402/backend/src/jobs.js:245)
- `payCtxOrder(...)` treats the call as USDC only when `paymentAsset`
  contains `usdc`; otherwise it sends raw XLM:
  [backend/src/payments/xlm-sender.js](/Users/ash/code/cards402/backend/src/payments/xlm-sender.js:205)
  [backend/src/payments/xlm-sender.js](/Users/ash/code/cards402/backend/src/payments/xlm-sender.js:213)
  [backend/src/payments/xlm-sender.js](/Users/ash/code/cards402/backend/src/payments/xlm-sender.js:243)

Impact:

- treasury XLM can be spent for orders that were supposed to be funded from
  user-paid USDC
- the DEX `sendMax` cap is bypassed on the retry path
- accounting and refund semantics can diverge from the original payment asset
  the user selected

Recommended fix direction:

- persist the expected retry parameters (`payment_asset`, `maxUsdc` /
  quoted send cap) and pass them through every recovery branch
- make `payCtxOrder(...)` reject ambiguous retry calls instead of silently
  defaulting to the XLM branch
- add an integration test that crashes between invoice creation and CTX
  payment for a USDC-funded order, then verifies the reconciler preserves
  the USDC path

### 10. VCC poll-based failure recovery marks orders failed without queueing a refund

Severity: High

Why this matters:

- The normal callback failure path in `cards402` marks the order failed and
  immediately calls `scheduleRefund(order_id)`.
- The polling fallback for lost callbacks has a separate failure branch.
- When that branch sees `vccJob.status === 'failed'`, it updates the order to
  `failed` but does not schedule a refund.
- This creates a split-brain recovery model where some failures refund
  automatically and others stop at `failed`, despite the public lifecycle
  promising “refund queued if possible”.

Evidence:

- lost-callback polling is implemented in `recoverStuckOrders()`:
  [backend/src/jobs.js](/Users/ash/code/cards402/backend/src/jobs.js:274)
- its `vccJob.status === 'failed'` branch only updates the order:
  [backend/src/jobs.js](/Users/ash/code/cards402/backend/src/jobs.js:351)
- the normal callback-driven failure path does queue a refund:
  [backend/src/api/vcc-callback.js](/Users/ash/code/cards402/backend/src/api/vcc-callback.js:236)
- public API/docs describe `failed` as “refund queued if possible”:
  [AGENTS.md](/Users/ash/code/cards402/AGENTS.md:91)

Impact:

- a lost callback followed by VCC poll recovery can leave customer funds
  stranded in `failed` without an automatic refund attempt
- operators may incorrectly believe the standard refund path already ran
- user-visible lifecycle behavior diverges based on which recovery mechanism
  happened to observe the failure first

Recommended fix direction:

- make the polling recovery branch call `scheduleRefund(order.id)` after a
  successful transition to `failed`
- centralize terminal-failure handling so callback, poll recovery, watchdog,
  and reconciler branches all share one refund-capable path
- add tests for “vcc job failed, callback lost” and assert the order reaches
  `refund_pending` / `refunded`

### 11. `vcc` CI and deploy controls allow known checks to be ignored and production to update directly from branch tip

Severity: Medium

Why this matters:

- `vcc`'s CI explicitly ignores `npm audit` failures and formatter failures.
- Both repos deploy by SSHing in as `root` and running `git pull origin main`
  directly on the production host, rather than deploying a pinned artifact
  produced by the validated CI run.
- The deploy workflows are independent push-triggered workflows, so they do not
  inherently wait for the corresponding CI workflow to pass.
- This weakens supply-chain and release assurance exactly for the systems that
  handle card data, callback secrets, and treasury keys.

Evidence:

- `vcc` CI ignores Prettier failures:
  [/Users/ash/code/vcc/.github/workflows/ci.yml](/Users/ash/code/vcc/.github/workflows/ci.yml:53)
- `vcc` CI ignores `npm audit` failures:
  [/Users/ash/code/vcc/.github/workflows/ci.yml](/Users/ash/code/vcc/.github/workflows/ci.yml:68)
- `cards402` CI blocks on audit, Semgrep, tests, and build:
  [.github/workflows/ci.yml](/Users/ash/code/cards402/.github/workflows/ci.yml:79)
- `cards402` production deploy SSHes as `root` and pulls `main` live:
  [.github/workflows/deploy.yml](/Users/ash/code/cards402/.github/workflows/deploy.yml:18)
  [.github/workflows/deploy.yml](/Users/ash/code/cards402/.github/workflows/deploy.yml:28)
- `vcc` deploy uses the same pattern:
  [/Users/ash/code/vcc/.github/workflows/deploy.yml](/Users/ash/code/vcc/.github/workflows/deploy.yml:20)
  [/Users/ash/code/vcc/.github/workflows/deploy.yml](/Users/ash/code/vcc/.github/workflows/deploy.yml:31)

Impact:

- dependency vulnerabilities or broken formatting gates in `vcc` can merge
  without CI failure
- production can update from branch tip rather than a CI-attested build output
- root-level SSH deploy expands the blast radius of workflow or secret misuse

Recommended fix direction:

- make `vcc` CI fail on audit findings and formatting drift, matching the
  stricter `cards402` posture
- gate deploy on a successful CI workflow and deploy an immutable artifact or
  commit SHA from that run, not a fresh `git pull`
- avoid routine `root` SSH deploys for app rollout; use a dedicated deploy user
  and least-privilege service restart path

### 12. The shipped CLI onboarding path drops OWS passphrase and vault-path safety controls

Severity: Medium

Why this matters:

- The OWS custody model in this project relies on two operator-controlled
  safety levers:
  - a passphrase for extra at-rest protection
  - a persistent `vaultPath` when the runtime filesystem is ephemeral
- The SDK and MCP support both, and the docs explicitly warn that losing the
  vault file means losing funds.
- But the first-party CLI path (`cards402 onboard` followed by
  `cards402 purchase`) does not carry either setting through.
- `onboard` creates the wallet with `createOWSWallet(walletName)` only, saves
  only `wallet_name` to config, and later CLI commands resolve the wallet by
  name alone on the default vault path.

Evidence:

- `onboard` creates the wallet without passphrase or `vaultPath`:
  [sdk/src/commands/onboard.ts](/Users/ash/code/cards402/sdk/src/commands/onboard.ts:129)
- the saved config schema has `vault_path`, but `onboard` does not persist it:
  [sdk/src/config.ts](/Users/ash/code/cards402/sdk/src/config.ts:18)
  [sdk/src/commands/onboard.ts](/Users/ash/code/cards402/sdk/src/commands/onboard.ts:110)
- `purchase` uses the configured wallet name only and does not pass a
  passphrase or `vaultPath` into `purchaseCardOWS(...)`:
  [sdk/src/commands/purchase.ts](/Users/ash/code/cards402/sdk/src/commands/purchase.ts:154)
  [sdk/src/commands/purchase.ts](/Users/ash/code/cards402/sdk/src/commands/purchase.ts:166)
- the read-only wallet CLI has the same limitation:
  [sdk/src/commands/wallet.ts](/Users/ash/code/cards402/sdk/src/commands/wallet.ts:37)
  [sdk/src/commands/wallet.ts](/Users/ash/code/cards402/sdk/src/commands/wallet.ts:41)
- project docs explicitly warn that ephemeral filesystems require
  `OWS_VAULT_PATH` and that a passphrase is advisable on shared storage:
  [web/public/agents.txt](/Users/ash/code/cards402/web/public/agents.txt:324)
  [web/public/agents.txt](/Users/ash/code/cards402/web/public/agents.txt:354)

Impact:

- agents following the CLI happy path are nudged toward an unencrypted default
  vault on the default home-directory path
- operators on ephemeral runtimes can believe they are “onboarded” while the
  wallet remains tied to non-persistent local storage
- later CLI commands may fail to find or unlock the intended wallet even if a
  safer custom vault path or passphrase was used out-of-band

Recommended fix direction:

- add CLI flags and config persistence for `--vault-path` and
  `--passphrase-env` / equivalent non-echoed passphrase handling
- make `onboard` warn loudly before creating a default-path wallet when the
  runtime looks ephemeral
- have `purchase` and `wallet` reuse persisted `vault_path` and explicit
  passphrase input instead of assuming the default vault

### 13. Critical payment and recovery defects are either untested or codified as acceptable behavior

Severity: Medium

Why this matters:

- Several of the highest-risk flaws found in this audit sit on code paths that
  the current automated tests do not exercise.
- In one case, the tests actively encode the buggy behavior as the expected
  result.
- That weakens confidence in CI and explains why payment-correctness and
  recovery regressions can reach production despite a non-trivial test suite.

Evidence:

- the end-to-end payment tests always simulate a full quoted amount and do not
  test underpayment rejection or amount mismatch handling:
  [backend/test/integration/e2e-cards402-vcc.test.js](/Users/ash/code/cards402/backend/test/integration/e2e-cards402-vcc.test.js:218)
  [backend/test/integration/e2e-cards402-vcc.test.js](/Users/ash/code/cards402/backend/test/integration/e2e-cards402-vcc.test.js:255)
- `recoverStuckOrders` tests assert that a VCC-polled failure becomes simply
  `failed`, with no refund expectation:
  [backend/test/unit/jobs.test.js](/Users/ash/code/cards402/backend/test/unit/jobs.test.js:105)
  [backend/test/integration/jobs.test.js](/Users/ash/code/cards402/backend/test/integration/jobs.test.js:19)
- callback tests do cover the callback-driven refund path, which highlights the
  inconsistency rather than closing it:
  [backend/test/integration/vcc-callback.test.js](/Users/ash/code/cards402/backend/test/integration/vcc-callback.test.js:204)
- signature tests explicitly preserve legacy v1 callback acceptance:
  [backend/test/unit/vcc-client.test.js](/Users/ash/code/cards402/backend/test/unit/vcc-client.test.js:103)

Impact:

- CI can stay green while core payment invariants remain broken
- recovery bugs become sticky because the test suite treats them as intended
  behavior
- protocol hardening work is harder to complete when downgrade compatibility is
  locked in by tests rather than temporary rollout checks

Recommended fix direction:

- add adversarial tests for underpayment, overpayment, wrong-asset payment, and
  replayed / mismatched payment events
- add recovery tests that require refunds on every terminal failure path,
  including VCC poll recovery
- move legacy protocol compatibility tests behind an explicit rollout flag or
  delete them once the deployed pair is confirmed on v3 only

### 14. Public API contract for `payment_asset` is internally inconsistent across docs, SDK types, and backend behavior

Severity: Medium

Why this matters:

- One set of published docs says `POST /v1/orders` accepts `payment_asset` and
  documents `invalid_payment_asset` as a possible error.
- Another set of published docs says there is no `payment_asset` in the request
  and that the caller chooses the asset later by invoking `pay_xlm` or
  `pay_usdc`.
- The backend implementation matches the second model: it always returns both
  quotes and does not read or validate `req.body.payment_asset`.
- The typed SDK also reflects the second model: `Cards402Client.createOrder()`
  does not expose a `payment_asset` option at all.

Evidence:

- `AGENTS.md` documents `payment_asset` on `POST /v1/orders` and an
  `invalid_payment_asset` error:
  [AGENTS.md](/Users/ash/code/cards402/AGENTS.md:33)
  [AGENTS.md](/Users/ash/code/cards402/AGENTS.md:232)
- `web/public/agents.txt` documents the opposite contract:
  [web/public/agents.txt](/Users/ash/code/cards402/web/public/agents.txt:166)
- backend order creation always builds both quotes and inserts the order
  without reading `payment_asset` from the request:
  [backend/src/api/orders.js](/Users/ash/code/cards402/backend/src/api/orders.js:336)
  [backend/src/api/orders.js](/Users/ash/code/cards402/backend/src/api/orders.js:355)
- SDK `OrderOptions` omits `payment_asset` entirely:
  [sdk/src/client.ts](/Users/ash/code/cards402/sdk/src/client.ts:40)

Impact:

- agent integrators can build against the wrong contract depending on which
  first-party doc they read
- callers may believe they requested XLM or USDC semantics at order-creation
  time when the backend ignored that field completely
- generated client types, tests, and operator expectations can drift in
  opposite directions

Recommended fix direction:

- choose one API contract and make docs, SDK types, tests, and backend match it
- if `payment_asset` is intentionally not part of order creation, remove it
  from public docs and delete the documented `invalid_payment_asset` error
- if it is meant to be accepted, implement and validate it explicitly in the
  backend and thread it through the SDK types

## Notes and follow-up work

Open questions now being checked:

- whether the remaining web/admin surfaces add any privilege-escalation or
  path-confusion issues beyond the backend authz already reviewed
- whether SDK/OWS defaults create custody or persistence footguns for agents
- whether contract governance or deployment docs materially overstate
  immutability relative to the upgradeable implementation
- whether tests and E2E coverage exercise the newly confirmed recovery bugs

Next execution block:

- continue into web/admin, SDK/OWS, contract, and test/control coverage
- then do another pass over both repos for lower-probability correctness and
  operational issues

## Coverage conclusion

Areas substantively reviewed in code:

- `cards402/backend` payment watcher, order creation, callback handling,
  refunds, jobs/recovery, auth, admin, dashboard, internal routes, env and
  secret handling
- `cards402/sdk` client, Soroban helpers, OWS integration, MCP server, CLI
  commands, local config handling
- `cards402/contract` Soroban receiver contract, upgrade path, tests, and
  deployment docs
- `cards402/web` admin session wrapper and admin proxy
- `cards402` CI/deploy workflows and test coverage
- `vcc/api` tenant auth, invoice/job API, callback sender, dead-letter retry,
  admin auth, crypto, env validation, fulfillment pipeline, CTX polling, and
  retention sweep
- `vcc` CI/deploy workflows

Additional passes performed after the first finding wave:

- re-checked recovery and refund paths for contradictory terminal behavior
- re-checked SDK/CLI custody flows against OWS documentation and config usage
- re-checked public API docs against backend and SDK implementation
- re-checked CI/tests for whether the discovered failures were actually covered

Current judgment:

- diminishing returns reached for this audit pass
- the remaining risk is more likely to be hidden in operational deployment
  state, external dependencies (live CTX / Soroban / Horizon behavior), or in
  runtime-only conditions that are not fully reproducible from static review
  inside this environment

## Execution limits

Runtime validation limits encountered:

- attempted local backend and `vcc` test runs hit sandbox restrictions around
  binding/listening sockets, so this pass relied primarily on static review and
  existing test code inspection rather than full test execution
- network-restricted environment prevented live CTX, Horizon, Soroban RPC, and
  production callback-path validation

These limits do not invalidate the findings above, but they do mean this audit
should be followed by a targeted remediation pass with live integration tests
outside the sandbox.
