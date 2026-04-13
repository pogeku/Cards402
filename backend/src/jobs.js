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
const { payCtxOrder } = require('./payments/xlm-sender');
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

// Expire pending_payment orders where the payment window has closed (2 hours).
// Fires webhooks to notify agents so they don't keep polling.
async function expireStaleOrders() {
  const { enqueueWebhook } = require('./fulfillment');

  // Fetch expiring orders before updating so we have webhook info
  const expiring = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT o.*, k.webhook_secret, k.default_webhook_url
    FROM orders o
    LEFT JOIN api_keys k ON o.api_key_id = k.id
    WHERE o.status = 'pending_payment'
      AND datetime(o.created_at) < datetime('now', '-2 hours')
  `,
      )
      .all()
  );

  if (expiring.length === 0) return;

  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE orders SET status = 'expired', updated_at = ?
    WHERE status = 'pending_payment' AND datetime(created_at) < datetime('now', '-2 hours')
  `,
  ).run(now);

  log(`expired ${expiring.length} stale order(s)`);

  // Notify agents via webhook (fire-and-forget)
  for (const order of expiring) {
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
  const cutoff = new Date(Date.now() - STUCK_RETRY_AFTER_MS).toISOString();
  const stuck = /** @type {any[]} */ (
    db
      .prepare(
        `
    SELECT * FROM orders
    WHERE status = 'ordering'
      AND (vcc_job_id IS NULL OR xlm_sent_at IS NULL OR vcc_notified_at IS NULL)
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
            log(`  ${shortId} → retry payCtxOrder`);
            await payCtxOrder(paymentUrl);
            db.prepare(`UPDATE orders SET xlm_sent_at = ?, updated_at = ? WHERE id = ?`).run(
              new Date().toISOString(),
              new Date().toISOString(),
              order.id,
            );
          }
        } else {
          log(`  ${shortId} → retry payCtxOrder`);
          await payCtxOrder(paymentUrl);
          db.prepare(`UPDATE orders SET xlm_sent_at = ?, updated_at = ? WHERE id = ?`).run(
            new Date().toISOString(),
            new Date().toISOString(),
            order.id,
          );
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

// Poll VCC for orders stuck in pending_payment or ordering where the callback may have been lost.
// Applies a 10-minute window — short enough to catch lost callbacks without hammering VCC.
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

  const { enqueueWebhook } = require('./fulfillment');

  for (const order of stuck) {
    try {
      const vccJob = await vccClient.getVccJobStatus(order.vcc_job_id);
      const now = new Date().toISOString();

      if (vccJob.status === 'delivered' && vccJob.card_number) {
        db.prepare(
          `
          UPDATE orders
          SET status = 'delivered', card_number = ?, card_cvv = ?, card_expiry = ?, card_brand = ?, updated_at = ?
          WHERE id = ?
        `,
        ).run(
          vccJob.card_number,
          vccJob.card_cvv,
          vccJob.card_expiry,
          vccJob.card_brand || null,
          now,
          order.id,
        );

        if (order.api_key_id) {
          db.prepare(
            `
            UPDATE api_keys
            SET total_spent_usdc = CAST(CAST(total_spent_usdc AS REAL) + CAST(? AS REAL) AS TEXT)
            WHERE id = ?
          `,
          ).run(order.amount_usdc, order.api_key_id);
        }

        const keyRow = /** @type {any} */ (
          order.api_key_id
            ? db
                .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
                .get(order.api_key_id)
            : null
        );
        const webhookUrl = order.webhook_url || keyRow?.default_webhook_url;
        if (webhookUrl) {
          enqueueWebhook(
            webhookUrl,
            {
              order_id: order.id,
              status: 'delivered',
              card: {
                number: vccJob.card_number,
                cvv: vccJob.card_cvv,
                expiry: vccJob.card_expiry,
                brand: vccJob.card_brand || null,
              },
            },
            keyRow?.webhook_secret || null,
          ).catch(() => {});
        }
        log(`  recovered ${order.id.slice(0, 8)} → delivered via VCC poll`);
      } else if (vccJob.status === 'failed') {
        const { publicMessage } = require('./lib/sanitize-error');
        db.prepare(
          `
          UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
        `,
        ).run(publicMessage(vccJob.error || 'vcc_failed'), now, order.id);
        log(`  recovered ${order.id.slice(0, 8)} → failed via VCC poll`);
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
        await fireWebhook(row.url, JSON.parse(row.payload), row.secret, null);
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
    db.prepare(
      `
      UPDATE approval_requests
      SET status = 'expired', decided_at = ?
      WHERE id = ?
    `,
    ).run(now, approval.id);
    db.prepare(
      `
      UPDATE orders
      SET status = 'rejected', error = ?, updated_at = ?
      WHERE id = ?
    `,
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
      const res = await fetch(`https://horizon.stellar.org/accounts/${row.wallet_public_key}`);
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

async function runJobs() {
  try {
    await expireStaleOrders();
    expireApprovalRequests();
    await reconcileOrderingFulfillment();
    await recoverStuckOrders();
    await retryWebhooks();
    pruneIdempotencyKeys();
  } catch (err) {
    console.error(`[jobs] unhandled error: ${err.message}`);
  }
}

function startJobs() {
  // Main reconciler tick — the slow one. Order expiry, stuck-order
  // recovery, webhook retries, etc. Safe to run at 5-minute cadence.
  runJobs();
  setInterval(runJobs, JOBS_INTERVAL_MS);

  // Funding check — runs on its own fast interval because the user is
  // actively waiting for the dashboard pill to flip after depositing.
  // Horizon is cheap, the query is bounded (only awaiting_funding rows),
  // and the emitted SSE event pushes to any open dashboard immediately.
  const FUNDING_INTERVAL_MS = parseInt(process.env.FUNDING_CHECK_INTERVAL_MS || '15000', 10);
  checkAgentFundingStatus();
  setInterval(checkAgentFundingStatus, FUNDING_INTERVAL_MS);

  // Alert evaluator — walks every enabled rule once a minute, fires
  // Discord on new firings, persists history. Cheap + bounded, runs in
  // the same process as everything else.
  const ALERT_INTERVAL_MS = parseInt(process.env.ALERT_INTERVAL_MS || '60000', 10);
  evaluateAlertsForAllDashboards().catch(() => {});
  setInterval(
    () => evaluateAlertsForAllDashboards().catch((err) => log(`alerts error: ${err.message}`)),
    ALERT_INTERVAL_MS,
  );

  log('background jobs started');
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
  expireStaleOrders,
  expireApprovalRequests,
  reconcileOrderingFulfillment,
  recoverStuckOrders,
  retryWebhooks,
  pruneIdempotencyKeys,
};
