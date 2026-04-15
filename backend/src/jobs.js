// @ts-check
// Background jobs — run on startup and on a repeating interval.
// Handles order expiry, stuck-order recovery, and unmatched payment refunds.

const db = require('./db');
const {
  fireWebhook,
  WEBHOOK_RETRY_DELAYS_MS,
  MAX_WEBHOOK_ATTEMPTS,
  scheduleRefund,
} = require('./fulfillment');
const vccClient = require('./vcc-client');
// Import as a module object so tests can monkey-patch `xlmSender.payCtxOrder`
// at runtime the same way they already do with `vccClient.getVccJobStatus`.
// Destructuring captures a reference at module load time, which defeats any
// post-require patch and makes the reconciler's ambiguous-park branch
// untestable without a full patchCache refactor.
const xlmSender = require('./payments/xlm-sender');
const { recordDecision } = require('./policy');

// Reconciler timings. After RETRY_AFTER_MS we retry a stuck step. After
// FAIL_AFTER_MS **and** vcc confirms the job isn't making progress, we hard-
// fail and let scheduleRefund return funds. Both configurable via env so ops
// can bump the timeout without a redeploy when the scraper is slow.
const STUCK_RETRY_AFTER_MS = parseInt(
  process.env.STUCK_RETRY_AFTER_MS || String(2 * 60 * 1000),
  10,
);
const STUCK_FAIL_AFTER_MS = parseInt(process.env.STUCK_FAIL_AFTER_MS || String(30 * 60 * 1000), 10);
const MAX_FULFILLMENT_ATTEMPTS = parseInt(process.env.MAX_FULFILLMENT_ATTEMPTS || '3', 10);

// Non-terminal vcc job statuses. If vcc still reports one of these, the
// reconciler must NOT hard-fail and refund — vcc is still working on it and
// will fire its HMAC callback when it lands, or we can pick the result up via
// recoverStuckOrders on the next tick.
const VCC_IN_PROGRESS_STATUSES = new Set([
  'invoice_issued',
  'queued',
  'running',
  'delivered', // terminal-success — don't refund, let the callback flow finish
]);

const JOBS_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function log(msg) {
  console.log(`[jobs] ${msg}`);
}

// Sentinel return from callPayCtxOrderWithAmbiguousPark — signals to the
// caller that the ambiguous-outcome branch ran, the row was parked, and
// the caller MUST NOT proceed to mark xlm_sent_at (which would unpark
// the row on the next tick).
const AMBIGUOUS_PARKED = Symbol('ctx_payment_ambiguous_parked');

// Wrap a payCtxOrder call with the ambiguous-outcome park path. If the
// send throws with stellarStatus in {unknown, applied_failed} AND a
// txHash is attached, this helper:
//
//   1. Persists the hash to orders.ctx_stellar_txid so ops can verify
//      on-chain.
//   2. Marks the order 'failed' with the public 'payment_pending_review'
//      message (see lib/sanitize-error.js — added in the same commit).
//   3. Emits a loud bizEvent so alerting pipelines can page.
//   4. Does NOT call scheduleRefund — an auto-refund would be a double-
//      spend if the original tx actually landed.
//   5. Returns AMBIGUOUS_PARKED so the caller can skip its own post-send
//      DB update (setting xlm_sent_at would unpark the row on the next
//      reconciler tick).
//
// Any other error rethrows unchanged and the caller's existing reconcile
// catch handles it via the attempt-counter + timeout logic.
//
// Mirrors the identical logic in payment-handler.js::handlePayment so
// both the first-pass and the reconciler retry paths cannot
// double-spend treasury.
async function callPayCtxOrderWithAmbiguousPark(paymentUrl, opts, orderId, shortId) {
  try {
    return await xlmSender.payCtxOrder(paymentUrl, opts);
  } catch (err) {
    const status = /** @type {any} */ (err)?.stellarStatus;
    const txHash = /** @type {any} */ (err)?.txHash;
    if ((status === 'unknown' || status === 'applied_failed') && txHash) {
      const { publicMessage } = require('./lib/sanitize-error');
      const { event: bizEvent } = require('./lib/logger');
      db.prepare(
        `UPDATE orders
         SET status = 'failed',
             error = ?,
             ctx_stellar_txid = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(publicMessage('ctx_payment_ambiguous'), txHash, new Date().toISOString(), orderId);
      bizEvent('ctx.payment_ambiguous', {
        order_id: orderId,
        stellar_status: status,
        tx_hash: txHash,
        via: 'reconcile',
        error: /** @type {Error} */ (err)?.message,
      });
      log(
        `  ${shortId} → ctx payment AMBIGUOUS [${status}] hash=${txHash} — parked, NO auto-refund`,
      );
      return AMBIGUOUS_PARKED;
    }
    throw err;
  }
}

// Expire pending_payment orders where the payment window has closed (2 hours).
// Fires webhooks to notify agents so they don't keep polling.
async function expireStaleOrders() {
  const { enqueueWebhook } = require('./fulfillment');

  // Adversarial audit F1-expire: SELECT-then-UPDATE-then-webhook used
  // to fire expired webhooks for rows from the initial SELECT without
  // confirming each row was actually flipped by the UPDATE. A
  // concurrent vcc-callback flipping pending_payment → delivered
  // between the SELECT and the UPDATE would leave the row in the
  // initial SELECT set (so we'd fire an 'expired' webhook) even
  // though the re-filtered UPDATE correctly skipped it. Agent ends
  // up with two contradictory notifications: "expired" followed by
  // "delivered".
  //
  // Fix: UPDATE first with a unique updated_at marker, then SELECT
  // rows matching status='expired' AND updated_at=@marker. That's
  // the exact set our UPDATE flipped, so the webhook fanout is
  // correct by construction — rows that raced to 'delivered' are
  // no longer in our result.
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const result = db
    .prepare(
      `
    UPDATE orders SET status = 'expired', updated_at = ?
    WHERE status = 'pending_payment' AND datetime(created_at) < datetime(?)
  `,
    )
    .run(now, cutoff);

  if (result.changes === 0) return;

  const expired = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT o.*, k.webhook_secret, k.default_webhook_url
    FROM orders o
    LEFT JOIN api_keys k ON o.api_key_id = k.id
    WHERE o.status = 'expired' AND o.updated_at = ?
  `,
      )
      .all(now)
  );

  log(`expired ${result.changes} stale order(s)`);

  // Notify agents via webhook (fire-and-forget)
  for (const order of expired) {
    const webhookUrl = order.webhook_url || order.default_webhook_url;
    if (webhookUrl) {
      enqueueWebhook(
        webhookUrl,
        {
          order_id: order.id,
          status: 'expired',
          phase: 'expired',
          note: 'Payment window expired. No funds were taken.',
        },
        order.webhook_secret || null,
      ).catch(() => {});
    }
  }
}

// Reconcile orders that crashed mid-fulfillment in handlePayment (index.js).
// These are orders in 'ordering' status where one of the steps didn't finish:
//
//   - getInvoice never ran         → vcc_job_id IS NULL
//   - payCtxOrder never ran/failed → vcc_job_id set, xlm_sent_at IS NULL
//   - notifyPaid never ran         → vcc_job_id set, xlm_sent_at set, vcc_notified_at IS NULL
//
// Each attempt is idempotent on the vcc side:
//   - getInvoice: UNIQUE(tenant_id, order_id) returns the existing job
//   - payCtxOrder: guarded by xlm_sent_at so a successful prior send is not retried
//   - notifyPaid: vcc returns {note: "already_queued"} if the job is past invoice_issued
//
// After STUCK_FAIL_AFTER_MS with no progress, or MAX_FULFILLMENT_ATTEMPTS retries,
// the order is marked failed and a refund is queued via scheduleRefund.
async function reconcileOrderingFulfillment() {
  // F2-reconcile: freeze-first short-circuit. Unlike the READ-only
  // recoverStuckOrders path (which just polls VCC status), reconcile
  // retries payCtxOrder — a real outbound treasury money movement.
  // The freeze flag is an emergency stop that also halts scheduleRefund
  // (via the freeze check I added earlier), so leaving reconcile
  // unconditional would let the retry path keep spending treasury
  // balance on every 5-minute tick while the refund path is blocked.
  // Stuck orders stay in 'ordering' until ops unfreezes, which is the
  // correct emergency-stop semantic.
  const { isFrozen } = require('./fulfillment');
  if (isFrozen()) {
    log('reconcileOrderingFulfillment skipped — system frozen');
    return;
  }

  const cutoff = new Date(Date.now() - STUCK_RETRY_AFTER_MS).toISOString();
  // Adversarial audit F1-jobs (2026-04-15): exclude rows where a prior
  // attempt parked an ambiguous CTX payment hash. Those rows are waiting
  // for operator verification — the outbound tx MAY have landed, and
  // re-firing payCtxOrder here would double-spend treasury. The parked
  // rows stay in status='ordering' but never re-enter the retry loop
  // until ops manually clears ctx_stellar_txid.
  const stuck = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT * FROM orders
    WHERE status = 'ordering'
      AND (vcc_job_id IS NULL OR xlm_sent_at IS NULL OR vcc_notified_at IS NULL)
      AND ctx_stellar_txid IS NULL
      AND updated_at < ?
  `,
      )
      .all(cutoff)
  );

  if (stuck.length === 0) return;
  log(`reconciling ${stuck.length} ordering-stuck order(s)`);

  const failCutoff = new Date(Date.now() - STUCK_FAIL_AFTER_MS).toISOString();

  for (const order of stuck) {
    const shortId = order.id.slice(0, 8);

    // Hard-fail if we've either timed out or exhausted retry budget — but
    // only if vcc doesn't still have the job in flight. Without this guard
    // we'd race vcc: the scraper could be seconds from delivering a card
    // when we queue a refund, leaving the user with both a card and a
    // refund. Poll vcc's job status first; if it's still in progress or
    // already delivered, postpone the fail.
    const timedOut = order.updated_at < failCutoff;
    const attemptsExhausted = order.fulfillment_attempt >= MAX_FULFILLMENT_ATTEMPTS;
    if (timedOut || attemptsExhausted) {
      const reason = timedOut ? 'fulfillment_stuck_timeout' : 'fulfillment_retries_exhausted';

      if (order.vcc_job_id) {
        let vccStatus = null;
        try {
          const vccJob = await vccClient.getVccJobStatus(order.vcc_job_id);
          vccStatus = vccJob?.status ?? null;
        } catch (err) {
          log(`  ${shortId} → vcc status check failed: ${err.message} — postponing hard-fail`);
          // Treat as in-progress: bump updated_at so we don't hammer vcc on
          // every 5-minute tick when vcc is down, and wait until it's back.
          db.prepare(`UPDATE orders SET updated_at = ? WHERE id = ?`).run(
            new Date().toISOString(),
            order.id,
          );
          continue;
        }
        if (vccStatus && VCC_IN_PROGRESS_STATUSES.has(vccStatus)) {
          log(`  ${shortId} → vcc reports ${vccStatus}; postponing hard-fail (letting vcc finish)`);
          // F1-reconcile: emit the same stuck_delivered bizEvent that
          // recoverStuckOrders emits, so ops see the signal regardless
          // of which reconciler path processed the order first. Without
          // this, a "vcc has delivered but we never got the callback"
          // case could sit silently in reconcile's postpone loop
          // forever, bumping updated_at on every tick, while
          // recoverStuckOrders is being starved out because the
          // updated_at gets bumped before its 10-min cutoff kicks in.
          if (vccStatus === 'delivered') {
            const { event: bizEvent } = require('./lib/logger');
            bizEvent('order.stuck_delivered', {
              order_id: order.id,
              vcc_job_id: order.vcc_job_id,
              age_minutes: Math.round((Date.now() - Date.parse(order.updated_at)) / 60000),
              via: 'reconcile',
            });
          }
          // Reset the clock so we give vcc another full FAIL_AFTER window
          // to land the card via its normal callback path.
          db.prepare(`UPDATE orders SET updated_at = ? WHERE id = ?`).run(
            new Date().toISOString(),
            order.id,
          );
          continue;
        }
      }

      log(`  ${shortId} → hard-fail (${reason}, attempt ${order.fulfillment_attempt})`);
      // Sanitise before storing — agents read this column.
      const { publicMessage } = require('./lib/sanitize-error');
      db.prepare(
        `
        UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
      `,
      ).run(publicMessage(reason), new Date().toISOString(), order.id);
      scheduleRefund(order.id).catch((err) =>
        log(`  ${shortId} refund schedule failed: ${err.message}`),
      );
      continue;
    }

    // Claim this attempt atomically so two overlapping job ticks don't both retry.
    const claim = db
      .prepare(
        `
      UPDATE orders
      SET fulfillment_attempt = fulfillment_attempt + 1, updated_at = ?
      WHERE id = ? AND status = 'ordering' AND fulfillment_attempt = ?
    `,
      )
      .run(new Date().toISOString(), order.id, order.fulfillment_attempt);
    if (claim.changes === 0) {
      log(`  ${shortId} — skipped (claim lost to concurrent retry)`);
      continue;
    }

    try {
      let vccJobId = order.vcc_job_id;
      let paymentUrl = null;

      // Step 1: ensure we have a vcc job. getInvoice is idempotent per order_id.
      if (!vccJobId) {
        log(`  ${shortId} → retry getInvoice`);
        const inv = await vccClient.getInvoice(
          order.id,
          order.amount_usdc,
          order.request_id,
          order.callback_nonce,
        );
        vccJobId = inv.vccJobId;
        paymentUrl = inv.paymentUrl;
        db.prepare(
          `UPDATE orders SET vcc_job_id = ?, callback_nonce = ?, updated_at = ? WHERE id = ?`,
        ).run(vccJobId, inv.callbackNonce, new Date().toISOString(), order.id);
      }

      // Step 2: ensure the XLM payment was sent. If xlm_sent_at is null we
      // retry, fetching the payment URL from vcc if we don't already have it.
      //
      // F9: the retry MUST preserve the original payment asset and sendMax
      // cap. Without it, a USDC-funded order whose initial payCtxOrder call
      // failed after getInvoice would silently re-send as raw treasury XLM
      // (no cap, wrong asset), draining the treasury. The first-pass path
      // in payment-handler.js passes `{ paymentAsset, maxUsdc }`; we rebuild
      // the same opts from the order row here.
      const retryOpts = {
        paymentAsset: order.payment_asset,
        maxUsdc: order.amount_usdc,
      };
      if (!order.xlm_sent_at) {
        if (!paymentUrl) {
          const vccJob = await vccClient.getVccJobStatus(vccJobId);
          paymentUrl = vccJob.payment_url;
          if (!paymentUrl) throw new Error('vcc job has no payment_url to retry');
          // If vcc says the job is already beyond invoice_issued, a previous
          // run must have paid — don't double-send, just mark xlm_sent_at.
          if (vccJob.status && vccJob.status !== 'invoice_issued') {
            log(`  ${shortId} → vcc reports ${vccJob.status}; skipping payCtxOrder`);
            db.prepare(`UPDATE orders SET xlm_sent_at = ?, updated_at = ? WHERE id = ?`).run(
              new Date().toISOString(),
              new Date().toISOString(),
              order.id,
            );
          } else {
            log(`  ${shortId} → retry payCtxOrder (asset=${retryOpts.paymentAsset})`);
            const txHash = await callPayCtxOrderWithAmbiguousPark(
              paymentUrl,
              retryOpts,
              order.id,
              shortId,
            );
            if (txHash === AMBIGUOUS_PARKED) continue;
            db.prepare(
              `UPDATE orders SET xlm_sent_at = ?, ctx_stellar_txid = ?, updated_at = ? WHERE id = ?`,
            ).run(new Date().toISOString(), txHash || null, new Date().toISOString(), order.id);
          }
        } else {
          log(`  ${shortId} → retry payCtxOrder (asset=${retryOpts.paymentAsset})`);
          const txHash = await callPayCtxOrderWithAmbiguousPark(
            paymentUrl,
            retryOpts,
            order.id,
            shortId,
          );
          if (txHash === AMBIGUOUS_PARKED) continue;
          db.prepare(
            `UPDATE orders SET xlm_sent_at = ?, ctx_stellar_txid = ?, updated_at = ? WHERE id = ?`,
          ).run(new Date().toISOString(), txHash || null, new Date().toISOString(), order.id);
        }
      }

      // Step 3: tell vcc we paid. Idempotent on vcc side.
      if (!order.vcc_notified_at) {
        log(`  ${shortId} → retry notifyPaid`);
        await vccClient.notifyPaid(vccJobId);
        db.prepare(`UPDATE orders SET vcc_notified_at = ?, updated_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          new Date().toISOString(),
          order.id,
        );
      }

      log(`  ${shortId} → reconciled; waiting for vcc callback`);
    } catch (err) {
      log(`  ${shortId} reconcile failed: ${err.message}`);
      // Leave status = 'ordering' and let the next tick retry until we hit the
      // timeout or attempt cap above.
    }
  }
}

// Poll VCC for orders stuck in pending_payment or ordering where the callback
// may have been lost. Applies a 10-minute window — short enough to catch lost
// callbacks without hammering VCC.
//
// F8: vcc strips card_number/cvv/expiry from GET /api/jobs/:id by design, so
// this poll cannot recover the card itself. Its only job is to detect
// terminal failures (so we can schedule a refund) and to surface a
// stuck-delivered state for ops when vcc says "delivered" but our row is
// still 'ordering' — that means the callback was lost permanently and the
// card sits in vcc's encrypted store. Ops manually reconcile via the vcc
// admin, which has key access; cards402 must NOT attempt to read card data
// from the job status endpoint.
//
// F10: the failure branch now calls scheduleRefund so the poll-recovery path
// matches the callback path — every terminal failure queues a refund, no
// split-brain between "failed-via-callback refunds" and "failed-via-poll
// doesn't".
async function recoverStuckOrders() {
  const stuck = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT * FROM orders
    WHERE status IN ('pending_payment', 'ordering')
      AND vcc_job_id IS NOT NULL
      AND datetime(updated_at) < datetime('now', '-10 minutes')
  `,
      )
      .all()
  );

  if (stuck.length === 0) return;
  log(`polling VCC for ${stuck.length} possibly-stuck order(s)`);

  for (const order of stuck) {
    try {
      const vccJob = await vccClient.getVccJobStatus(order.vcc_job_id);
      const now = new Date().toISOString();

      if (vccJob.status === 'delivered') {
        // Callback never arrived but vcc has the card. We intentionally do
        // NOT read card data from the job status endpoint — vcc strips it.
        // Log a stuck-delivered alert so ops can force-replay the callback
        // from vcc admin or manually recover. Nudge updated_at so we don't
        // re-alert on every 5-minute tick.
        log(`  STUCK DELIVERED ${order.id.slice(0, 8)} — vcc has card, callback lost`);
        const { event: bizEvent } = require('./lib/logger');
        // `via` tags which reconciler surfaced the signal so ops can
        // tell whether reconcile's postpone branch or recoverStuckOrders
        // saw it first. Both paths now emit with identical shape.
        bizEvent('order.stuck_delivered', {
          order_id: order.id,
          vcc_job_id: order.vcc_job_id,
          age_minutes: Math.round((Date.now() - Date.parse(order.updated_at)) / 60000),
          via: 'recover',
        });
        db.prepare(`UPDATE orders SET updated_at = ? WHERE id = ?`).run(now, order.id);
      } else if (vccJob.status === 'failed') {
        const { publicMessage } = require('./lib/sanitize-error');
        db.prepare(
          `
          UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
        `,
        ).run(publicMessage(vccJob.error || 'vcc_failed'), now, order.id);
        // F10: match the callback path — every terminal failure queues a refund
        scheduleRefund(order.id).catch((err) =>
          log(`  ${order.id.slice(0, 8)} refund schedule failed: ${err.message}`),
        );
        log(`  recovered ${order.id.slice(0, 8)} → failed via VCC poll; refund queued`);
      }
      // If still in-progress (awaiting_payment, queued, running) — leave it alone
    } catch (err) {
      log(`  VCC poll failed for ${order.id.slice(0, 8)}: ${err.message}`);
    }
  }
}

// Retry pending webhook deliveries with exponential backoff.
// Picks up rows where next_attempt <= now, attempts < MAX_WEBHOOK_ATTEMPTS, delivered = 0.
async function retryWebhooks() {
  const now = new Date().toISOString();
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT * FROM webhook_queue
    WHERE delivered = 0
      AND attempts <= ?
      AND next_attempt <= ?
  `,
      )
      .all(MAX_WEBHOOK_ATTEMPTS, now)
  );

  if (rows.length === 0) return;
  log(`retrying ${rows.length} webhook(s)`);

  // Fan out — don't block the job cycle on slow webhook endpoints
  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        // The queued payload is stored card-redacted (fulfillment.js::
        // enqueueWebhook). Before refiring, re-hydrate PAN / CVV / expiry
        // by unsealing the canonical card data from the orders table.
        // If the order is gone or the card columns are empty, ship the
        // redacted payload as-is — the agent will at least know what
        // happened even without the card fields.
        const payload = JSON.parse(row.payload);
        if (
          payload &&
          typeof payload === 'object' &&
          payload.status === 'delivered' &&
          payload.order_id &&
          payload.card &&
          payload.card.number === null
        ) {
          const orderRow = /** @type {any} */ (
            db
              .prepare(
                `SELECT card_number, card_cvv, card_expiry, card_brand FROM orders WHERE id = ?`,
              )
              .get(payload.order_id)
          );
          if (orderRow && orderRow.card_number) {
            // F1-retry-webhooks: catch vault-decrypt failures separately
            // from delivery failures. Before this, an openCard() throw
            // (GCM tag mismatch, key rotation, corrupted ciphertext)
            // propagated out of this block, landed in the generic
            // delivery catch, and burned 3 retry attempts over ~35
            // minutes before marking the row "webhook failed" with a
            // cryptic "card-vault: failed to open card_number" as the
            // last_error. The on-call engineer would then debug the
            // customer's endpoint when the real problem was in our
            // vault. Now we mark the row permanently failed on the
            // first open() throw, emit a distinct bizEvent so ops can
            // alert on vault-specific failures, and do NOT attempt to
            // fire the webhook with half-baked data (shipping
            // {status:'delivered', card:null} to the customer would be
            // worse than no delivery — they'd have no idea whether to
            // retry or accept).
            const { openCard } = require('./lib/card-vault');
            try {
              payload.card = openCard(orderRow);
            } catch (vaultErr) {
              const { event: bizEvent } = require('./lib/logger');
              const vaultMsg = vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
              log(`  webhook ${row.id.slice(0, 8)} abandoned: vault open failed — ${vaultMsg}`);
              bizEvent('webhook.vault_open_failed', {
                id: row.id,
                order_id: payload.order_id,
                url: row.url,
                attempts: row.attempts,
                error: vaultMsg,
              });
              db.prepare(
                `UPDATE webhook_queue
                 SET attempts = ?, last_error = ?, next_attempt = ?
                 WHERE id = ?`,
              ).run(MAX_WEBHOOK_ATTEMPTS + 1, `vault_open_failed: ${vaultMsg}`, now, row.id);
              return; // Skip the fire, skip the delivery catch path.
            }
          }
        }
        await fireWebhook(row.url, payload, row.secret, null);
        db.prepare(`UPDATE webhook_queue SET delivered = 1 WHERE id = ?`).run(row.id);
        log(`  webhook ${row.id.slice(0, 8)} delivered`);
      } catch (err) {
        const nextAttempts = row.attempts + 1;
        // Index by current attempts (not next) so delays map correctly:
        // attempts=1→delay[1]=5m, attempts=2→delay[2]=30m, attempts=3→delay[3]=null→abandon
        const delayMs = WEBHOOK_RETRY_DELAYS_MS[row.attempts] ?? null;
        if (delayMs === null || nextAttempts > MAX_WEBHOOK_ATTEMPTS) {
          db.prepare(
            `
          UPDATE webhook_queue SET attempts = ?, last_error = ?, next_attempt = ? WHERE id = ?
        `,
          ).run(nextAttempts, err.message, now, row.id);
          log(`  webhook ${row.id.slice(0, 8)} failed permanently: ${err.message}`);
          // Surface abandoned deliveries via bizEvent + /status metric.
          // Before this, a permanently failed webhook was visible only by
          // querying webhook_queue directly — which is how we found the
          // outbound-TLS bug the hard way. Now ops see the count on the
          // public status endpoint and can alert on it.
          const { event: bizEvent } = require('./lib/logger');
          bizEvent('webhook.failed_permanently', {
            id: row.id,
            url: row.url,
            attempts: nextAttempts,
            last_error: err.message,
          });
        } else {
          const nextAttempt = new Date(Date.now() + delayMs).toISOString();
          db.prepare(
            `
          UPDATE webhook_queue SET attempts = ?, last_error = ?, next_attempt = ? WHERE id = ?
        `,
          ).run(nextAttempts, err.message, nextAttempt, row.id);
          log(`  webhook ${row.id.slice(0, 8)} retry scheduled for ${nextAttempt}`);
        }
      }
    }),
  );
}

// Expire pending approval requests that have passed their 2-hour window.
// Transitions those orders to 'rejected' so agents get a clear terminal status.
function expireApprovalRequests() {
  const expired = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT * FROM approval_requests
    WHERE status = 'pending'
      AND datetime(expires_at) < datetime('now')
  `,
      )
      .all()
  );

  if (expired.length === 0) return;
  log(`expiring ${expired.length} approval request(s)`);

  const now = new Date().toISOString();
  for (const approval of expired) {
    // Atomic compare-and-swap: only flip 'pending' → 'expired'. If an
    // operator raced us to 'approved' or 'rejected' between our SELECT
    // above and this UPDATE, leave their decision alone and skip the
    // order-state flip below.
    const approvalChanged = db
      .prepare(
        `UPDATE approval_requests
         SET status = 'expired', decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, approval.id);
    if (approvalChanged.changes === 0) {
      log(`  approval ${approval.id.slice(0, 8)} decided by operator in-flight — skipping expiry`);
      continue;
    }
    db.prepare(
      `UPDATE orders
       SET status = 'rejected', error = ?, updated_at = ?
       WHERE id = ? AND status = 'awaiting_approval'`,
    ).run(
      'Approval request expired — owner did not respond within 2 hours',
      now,
      approval.order_id,
    );
    recordDecision(
      approval.api_key_id,
      approval.order_id,
      approval.amount_usdc,
      'blocked',
      'approval_expired',
      'Approval request expired after 2 hours without a decision',
    );
    log(
      `  expired approval ${approval.id.slice(0, 8)} → order ${approval.order_id.slice(0, 8)} rejected`,
    );
  }
}

// Retention sweep — purge sealed card columns after delivered orders age
// out. Adversarial audit F1: even sealed, the longer card data sits at
// rest the larger the at-rest blast radius. vcc already does its own
// retention sweep on the encrypted upstream copy; this is the cards402
// mirror so both stores converge on "delete the PAN once the agent
// no longer needs it from us".
//
// Default retention: 30 days. Tuned via CARD_RETENTION_DAYS. Card_brand
// stays — it isn't sensitive and is useful for analytics.
//
// Adversarial audit F2-prune: filter on `card_number IS NOT NULL`
// rather than `status = 'delivered'`. Today the vcc-callback flow
// only ever writes card data on the delivered transition, so the
// status filter is equivalent — but any future admin-override path
// that leaves card data on a non-delivered row (e.g. a manual
// refund post-delivery) would silently skip the purge and leak
// PAN/CVV past its TTL. Filtering on the presence of card data
// makes the privacy objective unambiguous.
function purgeOldCards() {
  const days = parseRetentionDays('CARD_RETENTION_DAYS', 30);
  const result = db
    .prepare(
      `
    UPDATE orders
    SET card_number = NULL, card_cvv = NULL, card_expiry = NULL
    WHERE card_number IS NOT NULL
      AND datetime(updated_at) < datetime('now', ?)
  `,
    )
    .run(`-${days} days`);
  if (result.changes > 0) log(`purged card data on ${result.changes} order(s)`);
}

// Clean up expired idempotency keys older than 24 hours
function pruneIdempotencyKeys() {
  const result = db
    .prepare(
      `
    DELETE FROM idempotency_keys
    WHERE datetime(created_at) < datetime('now', '-24 hours')
  `,
    )
    .run();
  if (result.changes > 0) log(`pruned ${result.changes} expired idempotency key(s)`);
}

// Delete sessions rows whose expires_at has passed. Without this the
// sessions table grows unboundedly — every login adds a row and
// nothing ever deletes one unless the user logs out explicitly. Prod
// was already carrying 3 expired rows out of 10; at pilot cadence
// that's fine, but at steady state the table grows at roughly
// (users × logins_per_day) per day.
function pruneExpiredSessions() {
  const result = db
    .prepare(`DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')`)
    .run();
  if (result.changes > 0) log(`pruned ${result.changes} expired session(s)`);
}

// Delete auth_codes rows older than their 15-minute TTL. Keeping used
// or expired OTP rows indefinitely is pure DB bloat — the row carries
// no value once it's been used or expired and all brute-force
// protection uses the short active window.
function pruneExpiredAuthCodes() {
  const result = db
    .prepare(
      `DELETE FROM auth_codes
       WHERE datetime(expires_at) < datetime('now', '-1 hours')`,
    )
    .run();
  if (result.changes > 0) log(`pruned ${result.changes} expired auth code(s)`);
}

// Delete agent_claims rows that are either (a) already used and
// older than 24h, or (b) expired unused for more than 24h. The
// sealed_payload column is already wiped at redemption time so
// there's no secret leak from keeping the row around, but the row
// itself is still garbage.
function pruneExpiredAgentClaims() {
  const result = db
    .prepare(
      `DELETE FROM agent_claims
       WHERE (used_at IS NOT NULL AND datetime(used_at) < datetime('now', '-24 hours'))
          OR (used_at IS NULL AND datetime(expires_at) < datetime('now', '-24 hours'))`,
    )
    .run();
  if (result.changes > 0) log(`pruned ${result.changes} stale agent claim(s)`);
}

// Delete webhook_deliveries rows older than WEBHOOK_LOG_RETENTION_DAYS
// (default 30). The table is a debugging / replay surface for
// operators — the recent window is useful, the historical tail is
// noise. Cards are already redacted from request_body by fulfillment.js
// before persistence so there's no data-minimisation concern beyond
// the standard "small tables are faster to query" argument.
function pruneWebhookDeliveries() {
  const days = parseRetentionDays('WEBHOOK_LOG_RETENTION_DAYS', 30);
  const result = db
    .prepare(`DELETE FROM webhook_deliveries WHERE datetime(created_at) < datetime('now', ?)`)
    .run(`-${days} days`);
  if (result.changes > 0) log(`pruned ${result.changes} webhook delivery log row(s)`);
}

// Delete policy_decisions older than POLICY_DECISIONS_RETENTION_DAYS
// (default 90). Policy decisions are audit info for "why was this
// order blocked" — a 90-day window is plenty for operator follow-up
// questions, and the audit_log has its own history.
function prunePolicyDecisions() {
  const days = parseRetentionDays('POLICY_DECISIONS_RETENTION_DAYS', 90);
  const result = db
    .prepare(`DELETE FROM policy_decisions WHERE datetime(created_at) < datetime('now', ?)`)
    .run(`-${days} days`);
  if (result.changes > 0) log(`pruned ${result.changes} policy decision(s)`);
}

// Parse a retention-days env var. Rejects:
//   - non-numeric input (parseInt → NaN)
//   - zero or negative values (would either wipe everything on every
//     tick via `-0 days` / `--5 days` or silently disable the prune
//     via datetime() parse failure)
//   - values over MAX_RETENTION_DAYS (defense against an env typo
//     producing an astronomical value that flips the WHERE clause)
// Invalid input logs a one-time warning and falls back to `defaultDays`.
// This is the F1-prune fix: every retention knob is now safe under
// misconfiguration instead of silently destroying card data or silently
// not pruning at all.
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650; // 10 years
const _warnedRetentionKeys = new Set();
function parseRetentionDays(envVarName, defaultDays) {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === null || raw === '') return defaultDays;
  const parsed = parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_RETENTION_DAYS ||
    parsed > MAX_RETENTION_DAYS ||
    String(parsed) !== raw.trim() // catches "3.14", "5abc", " 5", etc.
  ) {
    if (!_warnedRetentionKeys.has(envVarName)) {
      console.warn(
        `[jobs] ${envVarName}=${JSON.stringify(raw)} is not a valid retention ` +
          `day count (expected integer ${MIN_RETENTION_DAYS}-${MAX_RETENTION_DAYS}). ` +
          `Falling back to default ${defaultDays} days.`,
      );
      _warnedRetentionKeys.add(envVarName);
    }
    return defaultDays;
  }
  return parsed;
}

// Poll Horizon for every agent wallet sitting in 'awaiting_funding'.
// As soon as a wallet has enough XLM to pay the base reserve + any
// balance, transition the api_keys row to 'funded' and emit an
// agent_state event. Keeps the main dashboard pill in sync with
// on-chain reality without requiring the agent's CLI to keep
// reporting — the CLI disconnects after onboarding, so this is the
// only way the dashboard finds out funds landed.
async function checkAgentFundingStatus() {
  const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const awaiting = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, wallet_public_key
         FROM api_keys
         WHERE agent_state = 'awaiting_funding'
           AND wallet_public_key IS NOT NULL`,
      )
      .all()
  );
  if (awaiting.length === 0) return;

  const { emit: emitBusEvent } = require('./lib/event-bus');
  for (const row of awaiting) {
    try {
      // 5-second per-wallet timeout. Without this, a single slow /
      // dead Horizon response blocks the entire awaiting_funding
      // loop until Node's default socket-level timeout (which is
      // effectively never). A 5s cap means a Horizon incident can
      // only stretch one funding refresh tick by (num_awaiting × 5s)
      // worst case, and the guarded wrapper above won't stack
      // executions if the tick runs long.
      const res = await fetch(`https://horizon.stellar.org/accounts/${row.wallet_public_key}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue; // 404 = unactivated, try again next tick
      const data = /** @type {any} */ (await res.json());
      const balances = Array.isArray(data.balances) ? data.balances : [];
      const xlmStr = balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
      const usdcStr =
        balances.find(
          (b) =>
            b.asset_type === 'credit_alphanum4' &&
            b.asset_code === 'USDC' &&
            b.asset_issuer === USDC_ISSUER,
        )?.balance ?? '0';
      const xlm = parseFloat(xlmStr);
      const usdc = parseFloat(usdcStr);
      // Funded = at least 1 XLM past the Stellar base reserve, OR any
      // spendable USDC. Both cases mean the wallet can actually
      // attempt a purchase.
      const funded = xlm >= 2 || usdc > 0;
      if (!funded) continue;

      db.prepare(
        `UPDATE api_keys
         SET agent_state = 'funded',
             agent_state_at = @at,
             agent_state_detail = @detail
         WHERE id = @id`,
      ).run({
        id: row.id,
        at: new Date().toISOString(),
        detail: `xlm=${xlm.toFixed(4)} usdc=${usdc.toFixed(2)}`,
      });
      emitBusEvent('agent_state', {
        api_key_id: row.id,
        state: 'funded',
        wallet_public_key: row.wallet_public_key,
        detail: `xlm=${xlm.toFixed(4)} usdc=${usdc.toFixed(2)}`,
      });
    } catch (err) {
      // Transient Horizon failure — retry next tick.
      console.error(
        `[jobs] funding check failed for ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// Mutex guard for runJobs. setInterval does NOT await async callbacks,
// so if runJobs exceeds JOBS_INTERVAL_MS (e.g. because retryWebhooks is
// waiting on a slow webhook target or reconcileOrderingFulfillment is
// polling a degraded VCC) the next interval tick will fire a second
// concurrent runJobs execution. That races every SELECT+UPDATE inside
// the job and has doubled webhook notifications + doubled refunds in
// manual testing. Simple in-memory boolean guard closes the window.
let jobsRunning = false;

async function runJobs() {
  if (jobsRunning) {
    log('previous tick still in flight — skipping');
    return;
  }
  jobsRunning = true;
  try {
    await expireStaleOrders();
    expireApprovalRequests();
    await reconcileOrderingFulfillment();
    await recoverStuckOrders();
    await retryWebhooks();
    pruneIdempotencyKeys();
    pruneExpiredSessions();
    pruneExpiredAuthCodes();
    pruneExpiredAgentClaims();
    pruneWebhookDeliveries();
    prunePolicyDecisions();
    purgeOldCards();
  } catch (err) {
    console.error(`[jobs] unhandled error: ${err.message}`);
  } finally {
    jobsRunning = false;
  }
}

// Same pattern for checkAgentFundingStatus. The per-wallet Horizon
// fetch used to have no timeout (an invalid / dead / slow wallet would
// pile up concurrent executions on the FUNDING_INTERVAL_MS tick). Now
// the fetch has an AbortSignal timeout AND a mutex so a stuck one
// doesn't stack.
let fundingCheckRunning = false;

async function checkAgentFundingStatusGuarded() {
  if (fundingCheckRunning) return;
  fundingCheckRunning = true;
  try {
    await checkAgentFundingStatus();
  } catch (err) {
    console.error(`[jobs] funding check error: ${err.message}`);
  } finally {
    fundingCheckRunning = false;
  }
}

// Track every interval scheduled by startJobs() so the process
// signal handler in index.js can cancel them cleanly on SIGINT /
// SIGTERM. Without this, pm2's graceful-stop sent SIGINT, Node
// exited immediately, and any in-flight runJobs execution was
// abandoned mid-transaction.
const _jobIntervals = /** @type {NodeJS.Timeout[]} */ ([]);

function startJobs() {
  // Main reconciler tick — the slow one. Order expiry, stuck-order
  // recovery, webhook retries, etc. Safe to run at 5-minute cadence.
  runJobs();
  _jobIntervals.push(setInterval(runJobs, JOBS_INTERVAL_MS));

  // Funding check — runs on its own fast interval because the user is
  // actively waiting for the dashboard pill to flip after depositing.
  // Horizon is cheap, the query is bounded (only awaiting_funding rows),
  // and the emitted SSE event pushes to any open dashboard immediately.
  const FUNDING_INTERVAL_MS = parseInt(process.env.FUNDING_CHECK_INTERVAL_MS || '15000', 10);
  checkAgentFundingStatusGuarded();
  _jobIntervals.push(setInterval(checkAgentFundingStatusGuarded, FUNDING_INTERVAL_MS));

  // Alert evaluator — walks every enabled rule once a minute, fires
  // Discord on new firings, persists history. Cheap + bounded, runs in
  // the same process as everything else.
  const ALERT_INTERVAL_MS = parseInt(process.env.ALERT_INTERVAL_MS || '60000', 10);
  evaluateAlertsForAllDashboards().catch(() => {});
  _jobIntervals.push(
    setInterval(
      () => evaluateAlertsForAllDashboards().catch((err) => log(`alerts error: ${err.message}`)),
      ALERT_INTERVAL_MS,
    ),
  );

  log('background jobs started');
}

// Cancel every interval started by startJobs(). Called from the
// process shutdown handler in index.js on SIGINT / SIGTERM.
// In-flight jobs finish naturally because runJobs() is already
// guarded by the jobsRunning mutex — this stops new ticks from
// scheduling, nothing more.
function stopJobs() {
  while (_jobIntervals.length > 0) {
    const t = _jobIntervals.pop();
    if (t) clearInterval(t);
  }
  log('background jobs stopped');
}

// Evaluate alert rules for every dashboard. Per-dashboard to honour
// rules seeded under different operators once we have multi-user.
async function evaluateAlertsForAllDashboards() {
  const alerts = require('./lib/alerts');
  const db = require('./db');
  const rows = /** @type {any[]} */ (db.prepare(`SELECT id FROM dashboards`).all());
  for (const row of rows) {
    try {
      await alerts.evaluateRules(row.id);
    } catch (err) {
      log(`alerts dashboard=${row.id} error: ${err.message}`);
    }
  }
}

module.exports = {
  startJobs,
  stopJobs,
  expireStaleOrders,
  expireApprovalRequests,
  reconcileOrderingFulfillment,
  recoverStuckOrders,
  retryWebhooks,
  pruneIdempotencyKeys,
  pruneExpiredSessions,
  pruneExpiredAuthCodes,
  pruneExpiredAgentClaims,
  pruneWebhookDeliveries,
  prunePolicyDecisions,
  purgeOldCards,
};
