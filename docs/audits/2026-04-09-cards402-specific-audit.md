# cards402 Project-Specific Audit

Date: 2026-04-09
Auditor: Codex
Scope: Current repository snapshot in `/Users/ash/code/cards402`
Purpose: Convert the generic software audit framework into a cards402-specific rubric, then evaluate the project against that rubric.

## Audit status

- Completed for current repository snapshot

## cards402-specific audit checklist

This checklist is tailored to cards402 as a system that:
- accepts agent payments on Stellar,
- matches Soroban payment events to orders,
- buys third-party prepaid cards through CTX,
- extracts card details through browser automation,
- returns sensitive card data to agents,
- manages refunds and operator interventions,
- spans a public repo and a separate private backend repo.

### 1. Product contract and repo boundary

- Is the public/private split explained clearly?
- Can a contributor tell which components are source-available, which are private, and how they fit together?
- Are the stable agent-facing contracts clearer than the internal pipeline implementation?
- Is the product promise specific enough to test, such as payment assets, latency expectations, and refund semantics?

### 2. Agent payment flow

- Is order creation explicit, validated, and idempotent?
- Are payment instructions unambiguous for both USDC and XLM?
- Is the on-chain matching logic robust to duplicates, wrong assets, underpayments, late payments, and malformed order IDs?
- Are contract events and backend expectations aligned exactly?

### 3. Fulfillment pipeline

- Is the CTX ordering flow clearly isolated from payment detection?
- Are stage transitions explicit and durable?
- Are upstream failures, browser failures, and scraper failures handled predictably?
- Is the system simpler than the fulfillment problem, or hiding too much complexity in ad hoc logic?

### 4. Refund and recovery paths

- Can operators actually trigger refunds when needed?
- Are unmatched payments refunded in the correct asset?
- Are refund states and transaction IDs preserved cleanly?
- Do recovery jobs cover the real failure modes the system documents?

### 5. Sensitive data handling

- Are API keys and admin credentials handled safely?
- Are PAN/CVV/expiry values only exposed where necessary?
- Are secrets excluded from logs and source control?
- Is the admin surface sufficiently protected for a browser-accessed tool?

### 6. Supplier and scraper risk

- Are CTX dependencies explicit and contained?
- Are scraper components isolated enough to monitor and replace?
- Is there a practical plan for challenge solver failure, browser crashes, or DOM drift?
- Is there enough instrumentation to detect supplier or scraper breakage quickly?

### 7. Data model and auditability

- Can the database reconstruct the money and fulfillment lifecycle of an order?
- Are important payment/refund transitions durable and queryable?
- Are there enough constraints and indexes for correctness and operations?
- Is schema evolution managed safely?

### 8. Public API and SDK correctness

- Does the SDK model the backend contract faithfully?
- Are docs, SDK types, and HTTP responses aligned?
- Are error types actionable for agents?
- Is the public contract stable even if internal statuses change?

### 9. Operational readiness

- Are build, test, and verification commands trustworthy?
- Is the system observable enough for a money-moving operator workflow?
- Are runbooks, rollback expectations, and deployment boundaries documented?
- Are critical failure paths automated where possible and operator-friendly where automation stops?

### 10. Team and continuity risk

- Is ownership concentrated in too few people?
- Are review and dependency-update processes present?
- Is the split between public and private repos sustainable for onboarding and maintenance?
- Are current shortcuts explicit about which are acceptable now versus dangerous later?

## Executive summary

Overall health against the cards402-specific rubric: Moderate

Biggest strengths:
- Core product intent, architecture, and external dependencies are understandable from [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md).
- The Soroban contract, backend watcher, and order API are conceptually aligned around a clean event-driven payment model.
- The code anticipates real-world failure with retries, circuit breaking, persisted watcher cursors, unmatched-payment recording, and background recovery jobs.
- The SDK and public API shape are generally sensible for agent consumers.

Biggest concerns:
- Refund and operator recovery paths contain correctness gaps, which is the most important weakness for this product.
- Public docs drift from the intended stable API contract.
- Verification is not trustworthy enough yet because tests are not hermetic and the web build depends on live font fetches.
- The public/private repo split is valid, but not documented in a way that makes contributor expectations obvious.
- Operational observability is still light for a money-moving, supplier-dependent service.

Top priorities:
- Fix refund-path correctness first.
- Stabilize verification so tests and builds become trustworthy release signals.
- Align docs and SDK/backend contract language around stable agent-facing semantics.
- Add repo-boundary and runbook documentation to support internal continuity.

## Findings by tailored area

### 1. Product contract and repo boundary

Assessment: Moderate

Strengths:
- [`ARCHITECTURE.md`](/Users/ash/code/cards402/ARCHITECTURE.md) explains the core promise, payment flow, phases, and system shape.
- Product claims are concrete enough to audit, including payment assets, stable order phases, and fulfillment timing expectations.

Findings:

#### Public/private split is valid but not explicit enough for contributors
Severity: Medium

What I observed:
- [`.gitignore`](/Users/ash/code/cards402/.gitignore) ignores [`backend/`](/Users/ash/code/cards402/backend/).
- The root workspace still references `backend`.
- There is no root `README.md` explaining that the backend lives in a separate private repo.

Why it matters:
- Internal developers may know the intended shape, but the repo itself does not communicate it.
- This creates avoidable confusion around what “the project” means in public versus internal contexts.

Recommended fix:
- Add a root `README.md` that explicitly documents the split-repo model and expected usage for both internal and external contexts.

### 2. Agent payment flow

Assessment: Strong with correctness edge cases

Strengths:
- [`backend/src/api/orders.js`](/Users/ash/code/cards402/backend/src/api/orders.js) validates `amount_usdc`, `payment_asset`, and webhook URLs.
- Order creation supports idempotency with request fingerprinting.
- [`backend/src/payments/stellar.js`](/Users/ash/code/cards402/backend/src/payments/stellar.js) watches both `pay_usdc` and `pay_xlm` events and persists cursor state.
- [`contract/src/lib.rs`](/Users/ash/code/cards402/contract/src/lib.rs) and the watcher appear aligned on event symbols and payload shape.

Findings:

#### Overpayment behavior is operationally explicit but product-risky
Severity: Medium

What I observed:
- [`backend/src/index.js`](/Users/ash/code/cards402/backend/src/index.js) accepts overpayments and logs that excess is retained, with no automatic refund path for the excess.

Why it matters:
- The behavior is explicit in code, but retaining excess funds is a product/support risk unless documented and intended policy.

Recommended fix:
- Either document this behavior clearly in public docs and operator runbooks or add an excess refund path.

### 3. Fulfillment pipeline

Assessment: Moderate to strong

Strengths:
- [`backend/src/fulfillment.js`](/Users/ash/code/cards402/backend/src/fulfillment.js) keeps payment confirmation, CTX ordering, scraper stage 1, and scraper stage 2 in a readable sequence.
- State transitions are stored durably in the database.
- Browser pre-warming and retry wrappers show good practical attention to fulfillment latency and transient failures.

Findings:

#### Fulfillment complexity is real and mostly acknowledged, but scraper brittleness remains a primary system risk
Severity: Medium

What I observed:
- The critical path depends on CTX and two scraping stages, challenge solving, and browser automation.
- Those responsibilities are split into modules, but they remain tightly coupled to upstream page behavior.

Why it matters:
- This is likely the most brittle technical surface in the product.
- The architecture recognizes that, but replacement and diagnosis still depend heavily on implementation knowledge.

Recommended fix:
- Add stronger scraper-specific operational instrumentation and documented break/fix playbooks.

### 4. Refund and recovery paths

Assessment: Fragile

Strengths:
- The system records sender addresses, unmatched payments, refund transaction IDs, and refund-pending states.
- There are background jobs for stale-order expiry, stuck-order recovery, unmatched-payment refunds, and webhook retries.

Findings:

#### Admin manual refund path appears non-functional
Severity: High

What I observed:
- [`backend/src/api/admin.js`](/Users/ash/code/cards402/backend/src/api/admin.js) marks orders as `refund_pending`.
- [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js) does not process `refund_pending` orders.
- The actual send path lives in [`backend/src/fulfillment.js`](/Users/ash/code/cards402/backend/src/fulfillment.js) `scheduleRefund()`, which is not invoked by the admin endpoint.

Why it matters:
- Operators may think they have queued a refund when nothing will happen.

Recommended fix:
- Call `scheduleRefund()` directly from the admin refund endpoint or add a worker that explicitly drains `refund_pending`.

#### Unmatched XLM refunds are likely broken for `xlm_soroban`
Severity: High

What I observed:
- XLM contract payments are recorded as `xlm_soroban`.
- The unmatched refund job in [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js) only treats `payment_asset === 'xlm'` as XLM.
- `xlm_soroban` rows therefore do not map cleanly to the XLM refund branch.

Why it matters:
- Error-path fund recovery for unmatched XLM payments is likely to fail silently.

Recommended fix:
- Normalize asset naming or explicitly handle `xlm_soroban` in unmatched-payment refunds.

#### Webhook retry schedule does not match the intended recovery policy
Severity: High

What I observed:
- The documented retry plan is `30s`, `5m`, `30m`.
- The implementation in [`backend/src/jobs.js`](/Users/ash/code/cards402/backend/src/jobs.js) skips the `5m` tier due to indexing semantics.

Why it matters:
- Operator-facing delivery recovery is slower and less predictable than intended.

Recommended fix:
- Fix the attempt-to-delay mapping.

### 5. Sensitive data handling

Assessment: Moderate

Strengths:
- API keys are bcrypt-hashed.
- The admin secret uses timing-safe comparison.
- The admin UI intentionally keeps the secret in memory rather than persisting it to browser storage.

Findings:

#### Sensitive local env handling still needs stronger guardrails
Severity: High

What I observed:
- [`backend/.env`](/Users/ash/code/cards402/backend/.env) exists in the working tree.

Why it matters:
- Even if untracked, this is exactly the kind of file that becomes a secret-leak incident when process discipline slips.

Recommended fix:
- Enforce secret-file protections in pre-commit/CI and verify whether any secrets need rotation.

#### PAN/CVV return path is intentional but high-trust
Severity: Medium

What I observed:
- Delivered order responses include full card details from [`backend/src/api/orders.js`](/Users/ash/code/cards402/backend/src/api/orders.js).

Why it matters:
- This is necessary for the product, but it means API key compromise directly becomes card-data exposure.

Recommended fix:
- Treat API key issuance, storage, and revocation as a first-class security boundary and document that clearly.

### 6. Supplier and scraper risk

Assessment: Moderate

Strengths:
- CTX integration is isolated in [`backend/src/ctx/client.js`](/Users/ash/code/cards402/backend/src/ctx/client.js).
- Browser pooling and solver racing are deliberate attempts to reduce latency and failure.

Findings:

#### Supplier/scraper failure diagnosis is still too log-centric
Severity: Medium

What I observed:
- I found extensive `console.log` instrumentation but no metrics or alerting surfaces in the inspected source.

Why it matters:
- A scraper/supplier-dependent system needs fast detection of breakage, not just post hoc log reading.

Recommended fix:
- Add metrics for CTX failures, stage1/stage2 failure rates, challenge solver fallbacks, and refund rates.

### 7. Data model and auditability

Assessment: Moderate

Strengths:
- The order record plus unmatched payments and webhook queue are enough to reconstruct a large part of system behavior.
- Separate `stellar_txid` and `refund_stellar_txid` storage is a good auditability decision.

Findings:

#### Schema constraints and indexes are thinner than the operational surface suggests
Severity: Medium

What I observed:
- [`backend/src/db.js`](/Users/ash/code/cards402/backend/src/db.js) has few non-primary-key constraints and no visible indexes for frequent operational queries.
- Monetary values are stored as text.

Why it matters:
- Auditability exists, but scaling operator workflows and protecting invariants will get harder over time.

Recommended fix:
- Add indexes and stronger constraints around the main operational query paths and data relationships.

#### Migration management is still early-stage
Severity: Medium

What I observed:
- Schema changes are applied implicitly at startup through `ALTER TABLE` attempts.

Why it matters:
- This is workable early, but it is not a durable long-term migration discipline for a money-moving service.

Recommended fix:
- Move to explicit migrations before schema churn increases further.

### 8. Public API and SDK correctness

Assessment: Moderate

Strengths:
- [`sdk/src/client.ts`](/Users/ash/code/cards402/sdk/src/client.ts) exposes a useful agent-oriented API.
- The SDK error types are more actionable than raw HTTP failures.
- The `phase` abstraction is the right stability boundary for clients.

Findings:

#### Public docs drift from the stable contract
Severity: Medium

What I observed:
- [`web/app/docs/page.tsx`](/Users/ash/code/cards402/web/app/docs/page.tsx) emphasizes internal statuses instead of centering the stable `phase`.
- Error naming also drifts between docs and backend behavior.

Why it matters:
- SDK/backend correctness is undermined if public docs teach the wrong contract.

Recommended fix:
- Align docs to the stable public contract and treat internal statuses as implementation detail.

### 9. Operational readiness

Assessment: Moderate

Strengths:
- CI exists and covers lint, typecheck, test, build, contract build, and dependency audit paths.
- Doc sync checks in [`scripts/lint-docs.sh`](/Users/ash/code/cards402/scripts/lint-docs.sh) are a positive sign.

Findings:

#### Verification is not release-grade yet
Severity: High

What I observed:
- `npm test` does not complete cleanly in this environment and leaks real browser/listener side effects.
- `npm run build -w web` fails without live Google Fonts access.

Why it matters:
- For cards402, correctness and recovery confidence depend heavily on trustworthy automation.

Recommended fix:
- Make tests hermetic and make the web build network-independent.

#### Runbooks and deploy boundaries are under-documented
Severity: Medium

What I observed:
- I did not find visible runbooks, rollback docs, or deployment documentation in the repo.

Why it matters:
- In a service with money movement, suppliers, and browser automation, incident handling needs explicit guidance.

Recommended fix:
- Add operator-oriented runbooks and minimal deploy/rollback docs.

### 10. Team and continuity risk

Assessment: Moderate

Strengths:
- CODEOWNERS, PR templates, Dependabot, Husky, and CI are all present.

Findings:

#### Critical knowledge and approval remain concentrated
Severity: Medium

What I observed:
- [`.github/CODEOWNERS`](/Users/ash/code/cards402/.github/CODEOWNERS) routes all reviewed paths to `@ash`.
- The most brittle parts of the system are also the most specialized: fulfillment, scraper logic, refunds, and supplier integration.

Why it matters:
- The continuity risk here is not abstract. cards402 depends on a handful of brittle high-context flows.

Recommended fix:
- Reduce single-owner dependency over time through docs, runbooks, and broader code familiarity in the critical paths.

## cards402-specific quick wins

- Fix admin manual refunds so the endpoint actually triggers refund dispatch.
- Fix unmatched `xlm_soroban` refund handling.
- Fix webhook retry timing.
- Add a root `README.md` documenting the public/private repo split.
- Align the docs page with the stable `phase` and actual error codes.
- Vendor fonts or remove the external build-time dependency.

## cards402-specific medium-term improvements

- Add structured logs and basic business metrics around order creation, payment confirmation, fulfillment stages, failures, and refunds.
- Introduce explicit database migrations and indexes.
- Add incident/runbook docs for scraper breakage, CTX outage, refund failures, and system freeze/unfreeze.
- Reassess admin authentication if the dashboard grows beyond a tightly edge-protected internal tool.

## cards402-specific major risks to track

- Refund-path correctness during abnormal flows.
- Supplier and scraper brittleness under real-world drift.
- Operational blind spots caused by limited observability.
- Continuity risk across the public/private repo split and concentrated ownership.

## Conclusion

cards402 is not a generic CRUD or API project. Its core quality bar is whether it can safely move funds, match events, fulfill cards, recover from supplier/scraper failures, and refund users when things go wrong.

Against that bar, the project is promising but not yet fully hardened. The strongest parts are the system model and the main happy-path architecture. The weakest parts are the abnormal flows: refunds, recovery, operator confidence, and verification trustworthiness.

If the next development cycle is focused on refund correctness, hermetic verification, and operator-facing observability, the project’s risk profile improves materially without requiring a full architectural rewrite.
