# cards402 end-to-end audit

Date: 2026-04-09

Scope:
- `backend/`
- `sdk/`
- `web/`
- `contract/`
- root scripts and docs

## Summary

This audit reviewed the live code paths for order creation, approval, fulfillment callbacks, refunds, SDK purchase helpers, contract behavior, and repo verification scripts.

I found two material backend defects and one SDK defect, and fixed them during the audit:

1. Approval flows could mark an order approved without ever creating a VCC job or storing payment instructions.
2. The internal manual refund route passed the wrong argument type into `scheduleRefund()`.
3. The SDK all-in-one purchase helpers accepted `paymentAsset` but dropped it when creating an order.

I also fixed lint/typecheck blockers uncovered during verification.

## Findings

### Fixed: approval path could strand approved orders

Severity: high

Evidence:
- [`backend/src/api/admin.js`][admin-approve]
- [`backend/src/api/dashboard.js`][dashboard-approve]

Before the fix, approving an `awaiting_approval` request only flipped the order back to `pending_payment`. It did not call `dispatchFulfillment()`, so the order still had no `vcc_job_id` or `vcc_payment_json`. Agents polling the order after approval would see a payable state without usable payment instructions.

Fix:
- Both admin and dashboard approval handlers now create the VCC job first.
- Approval is committed only after the dispatch succeeds.
- The order is updated with `vcc_job_id` and serialized payment instructions.
- VCC failures now return `503 vcc_unavailable` instead of silently approving a broken order.

### Fixed: internal refund endpoint called `scheduleRefund()` incorrectly

Severity: medium

Evidence:
- [`backend/src/api/internal.js`][internal-refund]

The internal route loaded an order row and passed the whole object to `scheduleRefund()`, but `scheduleRefund()` expects an order ID string. That made internal manual refunds fail or no-op.

Fix:
- The route now calls `scheduleRefund(order.id)`.

### Fixed: SDK purchase helpers silently ignored `paymentAsset`

Severity: medium

Evidence:
- [`sdk/src/stellar.ts`][sdk-stellar]
- [`sdk/src/ows.ts`][sdk-ows]

Both `purchaseCard()` and `purchaseCardOWS()` accepted `paymentAsset`, then created the order without sending `payment_asset` to the API. That made the public helper API inconsistent with its own types and docs.

Fix:
- Both helpers now pass `payment_asset: paymentAsset` into `createOrder()`.

### Remaining: docs verification script is stale and fails against the current repo

Severity: medium

Evidence:
- [`scripts/lint-docs.sh`][docs-lint]
- [`README.md`][readme-structure]

`./scripts/lint-docs.sh` still expects deleted CTX/scraper files:
- `backend/src/ctx/client.js`
- `backend/src/scraper/stage1.js`
- `backend/src/scraper/stage2.js`
- `backend/src/scraper/challenge-solver.js`

It also fails because `sdk/README.md` does not document several exported SDK functions. As written, the repo-level `verify` target cannot pass on the current tree even after the code fixes above.

The top-level README also still states that `backend/` is closed-source and absent from the repo, which is false in this workspace.

Recommended follow-up:
- Update `scripts/lint-docs.sh` to reflect the VCC-based architecture.
- Either expand `sdk/README.md` or narrow the doc-lint rule to the intended public surface.
- Correct the top-level repository description.

## Verification

Passed:
- `cargo test` in [`contract/`](../../contract)
- `npm test -w sdk`
- `node --test test/unit/*.test.js` in [`backend/`](../../backend)
- `npm run lint`
- `npm run typecheck`

Failed:
- `./scripts/lint-docs.sh`
  - fails due stale file expectations and missing SDK README coverage

Partially blocked by sandbox:
- `npm test` at repo root
  - backend integration tests attempted to bind a local port and failed with `listen EPERM: operation not permitted 0.0.0.0` in this environment
- `npm run build`
  - an earlier `next build` process in the sandbox remained active, so a later run aborted with “Another next build process is already running”

## Residual risk

- The approval path fix covers the broken state transition, but the repo still lacks integration coverage for approval approval/rejection flows. Those should be added.
- Repo docs and CI verification are currently out of sync with the implemented VCC architecture, so documentation drift is still an operational risk.

[admin-approve]: /Users/ash/code/cards402/backend/src/api/admin.js#L272
[dashboard-approve]: /Users/ash/code/cards402/backend/src/api/dashboard.js#L315
[internal-refund]: /Users/ash/code/cards402/backend/src/api/internal.js#L91
[sdk-stellar]: /Users/ash/code/cards402/sdk/src/stellar.ts#L130
[sdk-ows]: /Users/ash/code/cards402/sdk/src/ows.ts#L236
[docs-lint]: /Users/ash/code/cards402/scripts/lint-docs.sh#L24
[readme-structure]: /Users/ash/code/cards402/README.md#L10
