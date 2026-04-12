# cards402 Live Audit

Date: 2026-04-09
Auditor: Codex
Scope: Current repository state in `/Users/ash/code/cards402`
Method: Evidence-based code and repo audit against the provided checklist. This document is being updated live during review and intentionally does not reuse prior audit files.

## Audit status

- Completed for current repository snapshot
- Old audit artifacts intentionally ignored: `claude-audit.md`, `codex-audit.md`, `audit-fixes.md`

## Executive summary

Overall health: Moderate

Biggest strengths:
- Clear high-level product intent in [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md)
- Monorepo layout separates backend, SDK, web, and contract concerns cleanly at a directory level
- Backend has meaningful automated tests in `backend/test`, and SDK/web also include test assets

Biggest concerns observed so far:
- No root `README.md`, which makes first-contact onboarding and project basics weaker than the checklist expects
- Generated/build output appears committed, including [`contract/target`](/Users/ash/code/cards402/contract/target) and [`sdk/dist`](/Users/ash/code/cards402/sdk/dist)
- Public docs and SDK/backend contracts are not fully aligned
- The public/private repo boundary is intentional but not documented clearly enough for contributors
- There are correctness bugs in refund handling paths
- Verification is weaker than it first appears because the test suite is not hermetic and the web build depends on live Google Fonts access

Top priorities:
- Fix test isolation so automation can be trusted
- Fix refund-path correctness bugs before relying on manual or unmatched-payment recovery
- Reconcile public API docs and SDK/backend behavior
- Remove or explicitly manage generated artifacts and repo completeness issues

## Findings by area

### Project basics

#### Project purpose is documented, but audience and milestone framing are incomplete
Severity: Medium

What I observed:
- [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md) gives a clear product description and payment flow.
- There is no root `README.md` to provide a concise entry point for the project.
- I have not yet found a roadmap or explicit current milestone document at the repo root.

Why it matters:
- A new engineer can infer what the product does, but not quickly enough from the expected entry point.
- Missing milestone and scope framing makes prioritization and auditability weaker.

Recommended fix:
- Add a root `README.md` with product summary, repo map, entry points, setup steps, and current milestone.

### Repository health

#### Public/private repo boundary is intentional but under-documented
Severity: Medium

What I observed:
- [`.gitignore`](/Users/ash/code/cards402/.gitignore) ignores [`backend/`](/Users/ash/code/cards402/backend/) entirely.
- The root workspace [`package.json`](/Users/ash/code/cards402/package.json) still declares `backend` as a workspace and routes `dev` and `test` commands through it.
- [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md) describes the backend as closed source.
- Project owner clarification: the backend is intentionally kept in a separate private repository and excluded from the public repo.

Why it matters:
- The split itself is reasonable, but contributors cannot infer the intended workflow from the repo alone.
- Public-repo onboarding, CI expectations, and local development ergonomics are harder than necessary when a core workspace is referenced without an explicit cross-repo setup model.

Recommended fix:
- Document the split explicitly in a root `README.md`: state that `backend` lives in a separate private repo, explain how the public repo is expected to be used without it, and describe the private-repo integration path for internal developers.

#### Generated artifacts are present in the repository tree
Severity: Medium

What I observed:
- Generated output directories are present, including [`contract/target`](/Users/ash/code/cards402/contract/target), [`sdk/dist`](/Users/ash/code/cards402/sdk/dist), [`sdk/coverage`](/Users/ash/code/cards402/sdk/coverage), [`web/.next`](/Users/ash/code/cards402/web/.next), and [`web/test-results`](/Users/ash/code/cards402/web/test-results).

Why it matters:
- Generated output makes the repo noisier, harder to review, and easier to accidentally commit.
- It also obscures whether the build is reproducible from source.

Recommended fix:
- Ensure generated directories are ignored via `.gitignore` and removed from tracked history if currently committed.

#### Sensitive local env file exists in the working tree
Severity: High

What I observed:
- [`backend/.env`](/Users/ash/code/cards402/backend/.env) exists alongside [`backend/.env.example`](/Users/ash/code/cards402/backend/.env.example).

Why it matters:
- A real environment file in-repo is a common source of accidental secret disclosure.
- Even if untracked today, the project needs stronger guardrails if live credentials are being handled this close to source.

Recommended fix:
- Confirm `.env` files are ignored, rotate any secrets if this file was ever committed elsewhere, and add a pre-commit or CI check preventing secret files from entering history.

### Local developer experience

#### Local setup entry point is weak at the repo root
Severity: Medium

What I observed:
- There is no root `README.md`.
- Subproject docs exist in [`sdk/README.md`](/Users/ash/code/cards402/sdk/README.md), [`web/README.md`](/Users/ash/code/cards402/web/README.md), and [`contract/README.md`](/Users/ash/code/cards402/contract/README.md).
- Root scripts exist for `dev`, `test`, `build`, `typecheck`, and `verify`, but there is no root-level explanation of prerequisites or expected service combinations.

Why it matters:
- The codebase is understandable once explored, but first-run setup is not low-friction.
- The checklist expects a new engineer to quickly identify entry points and workflow; that is currently discoverable only by reading multiple files.

Recommended fix:
- Add a root `README.md` that explains which parts are open-source, which parts are private, how to run each component, and what environment/services are required.

#### Web production build is not reproducible in offline or locked-down environments
Severity: Medium

What I observed:
- [`web/README.md`](/Users/ash/code/cards402/web/README.md) notes that the app uses `next/font/google`.
- `npm run build -w web` failed in this environment because `Geist` and `Geist Mono` could not be fetched from `fonts.googleapis.com`.

Why it matters:
- Production builds depend on third-party network availability unless fonts are vendored or cached.
- This weakens build reproducibility and can break CI or restricted deploy environments.

Recommended fix:
- Vendor the fonts locally or switch to a build path that does not require live font downloads.

### Correctness

#### Manual refund endpoint appears non-functional
Severity: High

What I observed:
- [`backend/src/api/admin.js`](/Users/ash/code/cards402/backend/src/api/admin.js) `POST /admin/orders/:id/refund` sets `status = 'refund_pending'` and returns success.
- [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js) does not process `refund_pending` orders.
- The actual refund send path is [`scheduleRefund()` in backend/src/fulfillment.js](/Users/ash/code/cards402/backend/src/fulfillment.js), but the admin endpoint does not call it.

Why it matters:
- Operators may believe they have manually queued a refund when in practice nothing will send.
- This is a payment correctness and support-risk issue, not just an ops UX problem.

Recommended fix:
- Have the admin refund endpoint call `scheduleRefund(order.id)` directly, or add an explicit background job that drains `refund_pending` orders.

#### Unmatched XLM payments are unlikely to be auto-refunded correctly
Severity: High

What I observed:
- [`backend/src/payments/stellar.js`](/Users/ash/code/cards402/backend/src/payments/stellar.js) records XLM contract payments as `paymentAsset: 'xlm_soroban'`.
- [`backend/src/index.js`](/Users/ash/code/cards402/backend/src/index.js) persists unmatched payments using that asset value.
- [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js) only treats `payment_asset === 'xlm'` as XLM when refunding unmatched payments; all other values fall into the USDC branch.
- For `xlm_soroban`, the refund job then looks for `amount_usdc`, which is null, and skips refunding.

Why it matters:
- If an agent pays XLM with a bad/unknown order ID or another unmatched condition, the automatic refund path can silently fail to act.
- This directly affects fund recovery in an error path.

Recommended fix:
- Normalize payment-asset values across the codebase or explicitly handle `xlm_soroban` in the unmatched refund job.

#### Webhook retry schedule skips the documented 5-minute retry tier
Severity: High

What I observed:
- [`backend/src/fulfillment.js`](/Users/ash/code/cards402/backend/src/fulfillment.js) documents retry delays as `30s`, `5m`, `30m` and enqueues failed first attempts with `attempts = 1` and `next_attempt = now + 30s`.
- [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js) computes `nextAttempts = row.attempts + 1` and then indexes `WEBHOOK_RETRY_DELAYS_MS[nextAttempts]`.
- With `attempts = 1`, the next failure uses index `2`, jumping straight to `30m` and skipping the `5m` delay.

Why it matters:
- Outbound webhooks recover more slowly than intended after transient failures.
- The implementation does not match its own documented retry policy.

Recommended fix:
- Base the retry delay on the current attempt count rather than the incremented count, or redefine the queue semantics so the index and comment match.

#### Public API documentation is inconsistent with the implemented API contract
Severity: Medium

What I observed:
- [`web/app/docs/page.tsx`](/Users/ash/code/cards402/web/app/docs/page.tsx) documents internal statuses like `pending_payment`, `ordering`, and `stage1_done` as public status states.
- The agent-facing API in [`backend/src/api/orders.js`](/Users/ash/code/cards402/backend/src/api/orders.js) exposes a stable `phase` abstraction for clients.
- The docs page lists `price_unavailable`, while the backend returns `xlm_price_unavailable` and the SDK maps both.

Why it matters:
- Clients can implement against the wrong contract and couple themselves to internal pipeline statuses.
- Documentation drift is especially risky on payment and fulfillment APIs.

Recommended fix:
- Update public docs to center the stable `phase` contract and align documented error codes with actual backend responses.

### Security

#### Admin default webhook URLs are not validated with the same SSRF checks as order webhooks
Severity: Medium

What I observed:
- [`backend/src/api/orders.js`](/Users/ash/code/cards402/backend/src/api/orders.js) validates `webhook_url` with `assertSafeUrl()`.
- [`backend/src/api/admin.js`](/Users/ash/code/cards402/backend/src/api/admin.js) validates `default_webhook_url` only for URL shape and HTTPS, not with `assertSafeUrl()`.
- [`backend/src/fulfillment.js`](/Users/ash/code/cards402/backend/src/fulfillment.js) applies `assertSafeUrl()` at send time, so fetches should still be blocked, but invalid entries can still be stored and retried operationally.

Why it matters:
- The fetch-time guard is good, but accepting unsafe URLs into configuration creates avoidable operational debt and repeated failed work.
- Security validation is more reliable when applied consistently at write time and execution time.

Recommended fix:
- Reuse `assertSafeUrl()` for admin webhook configuration validation.

#### Admin surface relies on a shared secret and browser-held credential
Severity: Medium

What I observed:
- The admin UI in [`web/app/admin/page.tsx`](/Users/ash/code/cards402/web/app/admin/page.tsx) sends `X-Admin-Secret` directly from the browser.
- The page intentionally keeps the secret only in React state, which is better than storage persistence.
- [`web/README.md`](/Users/ash/code/cards402/web/README.md) explicitly notes that `/admin` should be protected by Cloudflare Access or similar.

Why it matters:
- This can be acceptable for a small internal tool, but the trust model depends on external network controls and operator discipline rather than first-class identity.
- It increases exposure if the page is served in a broader environment than intended.

Recommended fix:
- Keep the current approach only if the admin page remains strictly edge-protected; otherwise move to server-side auth or an identity-aware proxy pattern.

### Data layer

#### Database schema is pragmatic but light on constraints and indexing
Severity: Medium

What I observed:
- [`backend/src/db.js`](/Users/ash/code/cards402/backend/src/db.js) enables `foreign_keys = ON`, but the schema defines no actual foreign-key relationships.
- Amounts and several domain fields are stored as `TEXT`.
- I did not find indexes beyond primary keys and the `UNIQUE` constraint on `api_keys.key_hash`.

Why it matters:
- SQLite is a reasonable fit here, but missing foreign keys and indexes increase the chance of orphaned data, slower operator queries, and weaker invariants as volume grows.
- Storing numeric fields as text pushes more correctness burden into application logic.

Recommended fix:
- Add indexes for common admin and recovery queries, introduce foreign keys where lifecycle ownership is clear, and consider storing monetary values in integer minor units where feasible.

#### Migration strategy is implicit rather than explicit
Severity: Medium

What I observed:
- Schema evolution happens inline in [`backend/src/db.js`](/Users/ash/code/cards402/backend/src/db.js) via startup `CREATE TABLE IF NOT EXISTS` and best-effort `ALTER TABLE` calls.
- I did not find a dedicated migration history or rollback mechanism.

Why it matters:
- This is fast to iterate on, but it makes schema change review, reversibility, and production safety weaker as the system matures.

Recommended fix:
- Introduce explicit migrations with version tracking before the schema becomes materially more complex.

### APIs and contracts

#### API versioning exists in path, but contract governance is still lightweight
Severity: Medium

What I observed:
- Agent APIs are namespaced under `/v1`.
- The PR template in [`.github/pull_request_template.md`](/Users/ash/code/cards402/.github/pull_request_template.md) asks contributors to check for breaking API changes.
- I did not find stronger contract tests or a formal change-management process for public API compatibility.

Why it matters:
- Path versioning is a good start, but payment APIs benefit from stronger compatibility discipline than checklist reminders alone.

Recommended fix:
- Add contract-focused tests and make public API changes explicit in release notes or changelog policy.

#### List-style API endpoints use limits but not a broader pagination pattern
Severity: Low

What I observed:
- [`backend/src/api/orders.js`](/Users/ash/code/cards402/backend/src/api/orders.js) and [`backend/src/api/admin.js`](/Users/ash/code/cards402/backend/src/api/admin.js) support `limit`, and the agent orders endpoint also supports `status`.
- I did not find cursor/page pagination or a documented pattern for larger result sets.

Why it matters:
- This is acceptable at current scale, but consistency becomes more important once order volume grows or admin tooling needs deeper history.

Recommended fix:
- Define a simple pagination convention before more list endpoints appear.

### Dependencies

#### Dependency maintenance posture is decent, but security audit evidence is incomplete from this environment
Severity: Medium

What I observed:
- [`.github/dependabot.yml`](/Users/ash/code/cards402/.github/dependabot.yml) is configured for weekly npm and GitHub Actions updates.
- CI includes `npm audit --audit-level=high` in [`.github/workflows/ci.yml`](/Users/ash/code/cards402/.github/workflows/ci.yml).
- I did not independently verify current vulnerability status here because online package audit requires network access.

Why it matters:
- The process signal is positive, but the current audit cannot certify dependency security without the actual audit result.

Recommended fix:
- Keep Dependabot and CI audit enforcement, and attach current audit results or SBOM/report artifacts to release workflows if stronger assurance is needed.

### Performance

#### Performance intent is visible, but measured budgets are sparse
Severity: Medium

What I observed:
- The architecture and code optimize for important paths, for example browser pre-warming in [`backend/src/scraper/browser-pool.js`](/Users/ash/code/cards402/backend/src/scraper/browser-pool.js).
- I did not find explicit performance budgets, load-test artifacts, or query-performance instrumentation.

Why it matters:
- The core business flow has latency expectations, but performance management appears mostly experiential rather than measured.

Recommended fix:
- Define performance targets for create-order, payment-detection, and fulfillment timing, then add lightweight measurements around those paths.

### Reliability and resilience

#### Resilience patterns exist, but they are unevenly encoded
Severity: Medium

What I observed:
- There are explicit retries in [`backend/src/lib/retry.js`](/Users/ash/code/cards402/backend/src/lib/retry.js), a freeze circuit breaker in [`backend/src/fulfillment.js`](/Users/ash/code/cards402/backend/src/fulfillment.js), and persisted watcher cursor state in [`backend/src/payments/stellar.js`](/Users/ash/code/cards402/backend/src/payments/stellar.js).
- There are also correctness gaps in some recovery paths, especially manual refunds and unmatched XLM refunds.

Why it matters:
- The service clearly anticipates partial failure, which is a strength.
- The remaining recovery bugs matter more in a money-moving system because operators depend on these paths under stress.

Recommended fix:
- Prioritize correctness of fallback/recovery flows before adding new resilience features.

### Testing

#### Automated tests are not hermetic and are difficult to trust as a clean signal
Severity: High

What I observed:
- `npm test` does not complete cleanly in this environment.
- Test output shows asynchronous activity after test completion, including `listen EPERM: operation not permitted 0.0.0.0`.
- Test output also shows real browser launch attempts from the backend scraper/browser pool during test execution.
- [`backend/test/unit/jobs.test.js`](/Users/ash/code/cards402/backend/test/unit/jobs.test.js) and [`backend/test/unit/fulfillment.test.js`](/Users/ash/code/cards402/backend/test/unit/fulfillment.test.js) exercise meaningful paths, but the suite still leaks real side effects.

Why it matters:
- Failing or hanging tests reduce confidence in regressions and slow development.
- If unit/integration tests can accidentally open listeners or launch browsers, they are not reliably CI-safe or sandbox-safe.

Recommended fix:
- Mock browser pool and long-running side effects at the module boundary, eliminate stray server/listener startup from tests, and split fast hermetic tests from full browser/integration coverage.

### Deployment and operations

#### Build and verification signals are uneven across subprojects
Severity: Medium

What I observed:
- `npm run typecheck` completed successfully.
- `npm run build -w sdk` completed successfully.
- `cargo test` in [`contract/`](/Users/ash/code/cards402/contract) passed.
- `npm run build -w web` failed on external font fetches.
- `npm test` produced broad failures and asynchronous leak warnings rather than a clean pass/fail signal.

Why it matters:
- Some parts of the repo are in good shape, but the overall verification story is not yet trustworthy.
- CI confidence is only as strong as the weakest core path.

Recommended fix:
- Make web builds network-independent where possible and stabilize backend tests until `npm test` is a dependable gate.

#### Infrastructure and deploy model are only lightly represented in-repo
Severity: Medium

What I observed:
- I did not find infrastructure-as-code, staging environment definitions, or operational runbooks in the repo.
- CI exists and covers lint/typecheck/test/build paths, but deploy automation is not visible from the inspected files.

Why it matters:
- This leaves production rollout, rollback, and disaster-recovery expectations largely implicit from the repo perspective.

Recommended fix:
- Add at least minimal runbooks and deployment/rollback documentation, even if infrastructure itself lives elsewhere.

### Observability

#### Logging exists, but structured observability is limited
Severity: Medium

What I observed:
- The backend relies heavily on `console.log` and `console.error` across fulfillment, jobs, watcher, and scraper modules.
- I did not find metrics, alert definitions, or tracing instrumentation in the inspected source.
- The web E2E config enables Playwright trace-on-retry, which helps tests but does not address production observability.

Why it matters:
- Text logs are useful early on, but diagnosing money-moving failures and supplier issues gets harder without metrics and correlation primitives.

Recommended fix:
- Introduce structured logs with stable fields first, then add a small set of business and system metrics around order phases, failures, retries, and refunds.

### Documentation

#### Documentation quality is mixed: strong component docs, weak repo-level onboarding
Severity: Medium

What I observed:
- [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md), [`sdk/README.md`](/Users/ash/code/cards402/sdk/README.md), [`web/README.md`](/Users/ash/code/cards402/web/README.md), and [`contract/README.md`](/Users/ash/code/cards402/contract/README.md) are useful.
- `scripts/lint-docs.sh` shows good intent to keep docs/config in sync.
- There is still no root `README.md`, no `CONTRIBUTING`, and no visible security policy or runbook material.

Why it matters:
- Individual areas are documented better than the project as a whole.
- Operational and contributor documentation remains shallow relative to the complexity of the system.

Recommended fix:
- Add a root `README.md`, a short `CONTRIBUTING.md`, and a minimal `SECURITY.md` or internal equivalent.

### Team process

#### Process hygiene is present, but ownership remains concentrated
Severity: Medium

What I observed:
- [`.github/CODEOWNERS`](/Users/ash/code/cards402/.github/CODEOWNERS) requires review and assigns all reviewed paths to `@ash`.
- There is a PR template, auto-labeling, Dependabot, commit linting, lint-staged, and pre-push hooks.

Why it matters:
- The repo has real process structure, which is good.
- It also shows knowledge and approval concentration in one owner, which is a delivery and continuity risk for critical paths.

Recommended fix:
- Keep the review controls, but reduce single-owner dependency for critical subsystems over time.

## Quick wins

- Add a root `README.md` that explains repo scope, private/open components, entry points, and common commands.
- Fix the admin manual refund path so it actually dispatches a refund.
- Fix unmatched XLM refund handling for `xlm_soroban`.
- Fix the webhook retry index bug in [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js).
- Align [`web/app/docs/page.tsx`](/Users/ash/code/cards402/web/app/docs/page.tsx) with the actual backend `phase` and error-code contract.
- Ignore or clean generated directories consistently, especially contract and web build outputs.

## Medium-term improvements

- Separate hermetic backend tests from tests that require browser/runtime side effects.
- Vendor production fonts or replace live Google font fetching in the web build.
- Clarify and document the public/private repository boundary for `backend` so workspace, docs, and git rules agree.
- Add explicit DB migrations, indexes, and stronger schema constraints.
- Introduce structured logging and a minimal operational metrics set.

## Major risks to track

- Backend reproducibility and knowledge concentration across the public/private repo boundary.
- Fulfillment correctness under real dependency failures, especially browser automation and upstream CTX interactions.
- Operational exposure of the admin surface, which currently depends on a shared secret and external network protections rather than a first-class auth system.
- Refund-path correctness, because these are the paths operators rely on when upstream or payment matching goes wrong.

## Checklist coverage

1. Project basics: Partially strong
Notes: Product intent is clear, but root-level onboarding, milestone framing, and repo-scope explanation are still weak.

2. Repository health: Moderate
Notes: Structure is understandable, but generated output is present and the public/private backend split is under-documented.

3. Local developer experience: Moderate
Notes: There are good scripts, but setup depends on reading multiple docs and some workflows are not reproducible in restricted environments.

4. Architecture: Strong
Notes: [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md) gives a useful high-level view and external dependencies are identifiable.

5. Code quality: Moderate to strong
Notes: Core files are readable and responsibilities are mostly sensible, though some critical flows are concentrated and a few abstractions remain operationally fragile.

6. Correctness: Moderate
Notes: Main flow design is coherent, but refund-path bugs materially lower confidence in exception handling.

7. Testing: Moderate to fragile
Notes: There is real test coverage, but automation is not hermetic enough to fully trust as a release gate today.

8. Security: Moderate
Notes: Input validation and SSRF awareness are good, but admin auth is still lightweight and validation consistency can improve.

9. Data layer: Moderate
Notes: SQLite is workable here, but constraints, indexes, and migrations are thinner than ideal.

10. APIs and contracts: Moderate
Notes: `/v1` versioning exists and errors are structured, but docs drift and contract governance are still light.

11. Dependencies: Moderate
Notes: Dependabot and CI audit checks exist, but this audit could not independently validate live vulnerability status.

12. Performance: Moderate
Notes: There are practical optimizations, but little evidence of measured budgets or sustained performance validation.

13. Reliability and resilience: Moderate
Notes: Good instincts are visible in retries, freezing, and persisted cursors, but recovery-path bugs matter.

14. Deployment and operations: Moderate
Notes: CI exists, but deploy/rollback/runbook material is not clearly represented in-repo.

15. Observability: Moderate to weak
Notes: Logging exists, but metrics, alerts, and tracing are not evident.

16. Documentation: Moderate
Notes: Component docs are good; repo-level and operational docs are not yet good enough for first-contact onboarding.

17. Team process: Moderate
Notes: Review/process scaffolding exists, but ownership is concentrated.

18. Risk review: Completed
Notes: The main tracked risks are repo boundary clarity, fulfillment/recovery correctness, admin exposure, and operator recovery paths.

## Evidence log

- Root `README.md` not found.
- Root workspace package exists with scripts for `dev`, `lint`, `typecheck`, `test`, `build`, and `verify`.
- Backend package is plain JavaScript, not TypeScript.
- Backend tests exist in both `unit` and `integration` directories.
- `.gitignore` ignores the whole `backend/` directory.
- `npm run typecheck` passed.
- `npm run build -w sdk` passed.
- `cargo test` in `contract/` passed.
- `npm run build -w web` failed because `next/font/google` could not fetch `Geist` and `Geist Mono`.
- `npm test` produced broad backend test failures, async leak warnings, and real browser-launch side effects.
- `scripts/lint-docs.sh` enforces some useful doc/config consistency checks.
- CODEOWNERS, PR template, Dependabot, Husky hooks, and CI workflows are present.
- I did not find visible `CONTRIBUTING`, `SECURITY`, or deploy/runbook documents in the inspected repo.

## Audit limits

- This audit covers the current repository snapshot, not the separate private backend repository as a managed standalone repo with its own history and process.
- I could not independently verify live dependency vulnerability status from this restricted environment.
- I did not audit real production infrastructure, cloud configuration, secret stores, or runtime alerting systems beyond what is represented in repo files.
- `npm test` did not complete cleanly, so some verification conclusions are based on concrete failure symptoms rather than a full green/red matrix of all intended tests.

## Open questions

- Whether generated directories are tracked in Git history or only present in a dirty/uninitialized worktree.
- Whether the live `backend/.env` contains production-like secrets and whether secret scanning is enforced in CI.
- Whether a roadmap/current milestone exists outside the files inspected so far.
- Whether the admin surface is expected to remain protected only by a shared secret plus edge/network controls.
- Whether the public repo should keep `backend` as a workspace reference or replace that with documentation/stubs better suited to the split-repo model.
- Current live dependency vulnerability status from `npm audit`, which I did not independently verify from this restricted environment.
