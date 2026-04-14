// @ts-check
// Soroban payment event handler — factored out of index.js so integration
// tests can exercise the full pipeline (getInvoice → payCtxOrder → notifyPaid)
// without having to boot the Express server or the stellar watcher.
//
// On-chain flow:
//   1. Agent invokes pay_usdc / pay_xlm on the receiver contract.
//   2. backend/src/payments/stellar.js sees the event and calls handlePayment.
//   3. This module validates the event amount against the order's quoted
//      amount (adversarial audit F0 — treasury-loss exploit). Mismatches,
//      unknown order_ids, and duplicates are routed to unmatched_payments
//      (F7) with a reason so ops can refund them.
//   4. On a valid match this atomically claims the order (pending_payment →
//      ordering) and runs the three vcc-client steps, persisting a checkpoint
//      after each one so the reconciler in jobs.js can recover from a mid-
//      flight crash without double-paying.

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { getInvoice, notifyPaid } = require('./vcc-client');
const { payCtxOrder } = require('./payments/xlm-sender');
const { scheduleRefund } = require('./fulfillment');
const { event: bizEvent } = require('./lib/logger');

/**
 * Compare two decimal-string amounts without losing precision.
 * Returns 1/-1/0 like a classic C comparator. Treats null/undefined as 0.
 * Scales both sides to 7 decimal places (Stellar's stroop precision) via
 * BigInt so we never round-trip through JS floats.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 */
function compareDecimal(a, b) {
  const A = toStroops(a);
  const B = toStroops(b);
  if (A > B) return 1;
  if (A < B) return -1;
  return 0;
}

/** @param {string|null|undefined} s */
function toStroops(s) {
  if (s === null || s === undefined || s === '') return 0n;
  const str = String(s).trim();
  const neg = str.startsWith('-');
  const abs = neg ? str.slice(1) : str;
  const [whole, frac = ''] = abs.split('.');
  const paddedFrac = (frac + '0000000').slice(0, 7);
  const value = BigInt(whole || '0') * 10_000_000n + BigInt(paddedFrac || '0');
  return neg ? -value : value;
}

/** @param {bigint} stroops */
function stroopsToDecimal(stroops) {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = String(abs % 10_000_000n).padStart(7, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Record an on-chain payment that couldn't be matched to a valid pending
 * order. The `unmatched_payments` table is the reconciliation queue for
 * refunds — every row here represents real funds sitting in the receiver
 * contract that ops will need to refund (manually or via a reconciler).
 * @param {{txid: string, senderAddress: string|null, paymentAsset: string, amountUsdc: string|null, amountXlm: string|null, orderId: string|null, reason: string}} row
 */
function recordUnmatchedPayment(row) {
  try {
    db.prepare(
      `INSERT INTO unmatched_payments
         (id, stellar_txid, sender_address, payment_asset, amount_usdc, amount_xlm, claimed_order_id, reason)
       VALUES (@id, @txid, @sender, @asset, @amountUsdc, @amountXlm, @orderId, @reason)`,
    ).run({
      id: uuidv4(),
      txid: row.txid,
      sender: row.senderAddress,
      asset: row.paymentAsset,
      amountUsdc: row.amountUsdc,
      amountXlm: row.amountXlm,
      orderId: row.orderId,
      reason: row.reason,
    });
    bizEvent('payment.unmatched', {
      txid: row.txid,
      reason: row.reason,
      order_id: row.orderId,
      asset: row.paymentAsset,
      amount_usdc: row.amountUsdc,
      amount_xlm: row.amountXlm,
    });
  } catch (err) {
    // Don't let an unmatched-payment log failure swallow the outer error.
    // The watcher will replay this event on the next poll (txid dedupe in
    // index.js guards against double-processing on the happy path, but
    // unmatched rows are the safety net when dedupe itself misfires).
    console.error(`[payment] failed to record unmatched payment ${row.txid}: ${err.message}`);
  }
}

async function handlePayment({
  txid,
  paymentAsset,
  amountUsdc,
  amountXlm,
  senderAddress,
  orderId,
}) {
  const order = /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));

  // F7: unknown order_id — record for refund and bail out. The receiver
  // contract has funds that don't belong to anyone we know about.
  if (!order) {
    recordUnmatchedPayment({
      txid,
      senderAddress,
      paymentAsset,
      amountUsdc,
      amountXlm,
      orderId,
      reason: 'unknown_order',
    });
    return;
  }

  // F7: order exists but isn't awaiting payment. Either it already
  // transitioned (duplicate event, concurrent pay_usdc + pay_xlm, etc.)
  // or it was expired/rejected before the chain caught up. Either way the
  // funds need to be refunded.
  if (order.status !== 'pending_payment') {
    recordUnmatchedPayment({
      txid,
      senderAddress,
      paymentAsset,
      amountUsdc,
      amountXlm,
      orderId,
      reason: `order_status_${order.status}`,
    });
    return;
  }

  // F0: validate the on-chain amount against the quoted amount for the
  // asset the agent chose. Underpayment is the treasury-loss exploit —
  // without this check, a $0.01 pay_usdc against a $100 order would
  // cause us to spend $100 of treasury to fulfill it.
  //
  // Overpayment is accepted (agents paying slightly more out of rounding
  // caution is normal) and the excess is recorded for refund bookkeeping.
  // Underpayment and wrong-asset events are routed to unmatched_payments.
  let excessUsdc = null;
  let excessXlm = null;
  if (paymentAsset === 'usdc_soroban') {
    const expected = order.amount_usdc;
    const cmp = compareDecimal(amountUsdc, expected);
    if (cmp < 0) {
      recordUnmatchedPayment({
        txid,
        senderAddress,
        paymentAsset,
        amountUsdc,
        amountXlm,
        orderId,
        reason: 'underpaid_usdc',
      });
      return;
    }
    if (cmp > 0) {
      const excess = toStroops(amountUsdc) - toStroops(expected);
      excessUsdc = stroopsToDecimal(excess);
    }
  } else if (paymentAsset === 'xlm_soroban') {
    const expected = order.expected_xlm_amount;
    if (!expected) {
      // Order was created when the XLM price oracle was unavailable, so the
      // XLM branch was never offered to the agent. An incoming pay_xlm
      // event here is adversarial or massively late — reject it.
      recordUnmatchedPayment({
        txid,
        senderAddress,
        paymentAsset,
        amountUsdc,
        amountXlm,
        orderId,
        reason: 'xlm_not_quoted',
      });
      return;
    }
    const cmp = compareDecimal(amountXlm, expected);
    if (cmp < 0) {
      recordUnmatchedPayment({
        txid,
        senderAddress,
        paymentAsset,
        amountUsdc,
        amountXlm,
        orderId,
        reason: 'underpaid_xlm',
      });
      return;
    }
    if (cmp > 0) {
      const excess = toStroops(amountXlm) - toStroops(expected);
      excessXlm = stroopsToDecimal(excess);
    }
  } else {
    recordUnmatchedPayment({
      txid,
      senderAddress,
      paymentAsset,
      amountUsdc,
      amountXlm,
      orderId,
      reason: 'unknown_asset',
    });
    return;
  }

  const now = new Date().toISOString();

  // Atomic transition — guards against duplicate payment events for the same
  // order. If two pay_usdc events for the same order_id arrive, only the
  // first claims the row; the second finds status != 'pending_payment' on
  // the re-read below (guarded by changes === 0) and we record it as a
  // duplicate unmatched payment.
  const claimed = db
    .prepare(
      `
    UPDATE orders
    SET status = 'ordering', payment_asset = ?, stellar_txid = ?,
        sender_address = ?, payment_xlm_amount = ?,
        excess_usdc = COALESCE(?, excess_usdc),
        updated_at = ?
    WHERE id = ? AND status = 'pending_payment'
  `,
    )
    .run(paymentAsset, txid, senderAddress, amountXlm, excessUsdc, now, orderId);

  if (claimed.changes === 0) {
    // Lost the race — another event already claimed the order between our
    // status check above and the UPDATE. Record this one as a duplicate.
    recordUnmatchedPayment({
      txid,
      senderAddress,
      paymentAsset,
      amountUsdc,
      amountXlm,
      orderId,
      reason: 'duplicate_payment',
    });
    return;
  }

  // Excess XLM tracking is belt-and-braces; the schema only has excess_usdc
  // right now, so XLM overpayment is logged to the bizEvent stream for ops
  // visibility even though it doesn't persist on the row. Real refund
  // tracking for XLM overpayment is out of scope for F0 — the important
  // invariant is that we don't under-collect, not that we perfectly refund
  // every over-collected stroop.
  if (excessXlm) {
    bizEvent('payment.xlm_overpaid', {
      order_id: orderId,
      excess_xlm: excessXlm,
      txid,
    });
  }

  try {
    const { vccJobId, paymentUrl, callbackNonce } = await getInvoice(
      orderId,
      order.amount_usdc,
      order.request_id,
    );
    db.prepare(
      `UPDATE orders SET vcc_job_id = ?, callback_nonce = ?, updated_at = ? WHERE id = ?`,
    ).run(vccJobId, callbackNonce, new Date().toISOString(), orderId);

    // Branch Stellar payment on what the agent paid us:
    //   - XLM → forward as-is from treasury (single-op payment)
    //   - USDC → two-op atomic tx (PathPaymentStrictSend into treasury
    //     + plain Payment forwarding the invoice XLM to CTX). See the
    //     sendUsdcAsXlm header for the 2026-04-14 bug that forced the
    //     split — CTX's payment watcher ignores path_payment_* ops.
    // order.amount_usdc is the USDC the agent paid (the order's USD
    // face value); it's the sendAmount ceiling on the strict-send side.
    await payCtxOrder(paymentUrl, {
      paymentAsset,
      maxUsdc: order.amount_usdc,
    });
    db.prepare(`UPDATE orders SET xlm_sent_at = ?, updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      new Date().toISOString(),
      orderId,
    );

    await notifyPaid(vccJobId);
    db.prepare(`UPDATE orders SET vcc_notified_at = ?, updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      new Date().toISOString(),
      orderId,
    );
  } catch (err) {
    // Log the raw error server-side for ops debugging — full stack
    // trace, internal vocab, all of it. The publicly-stored version
    // gets sanitised so agents can't see the moving parts.
    console.error(`[payment] order ${orderId.slice(0, 8)} fulfillment error: ${err.message}`);
    const { publicMessage } = require('./lib/sanitize-error');
    db.prepare(`UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(
      publicMessage(err.message),
      new Date().toISOString(),
      orderId,
    );
    scheduleRefund(orderId).catch((e) =>
      console.error(`[payment] refund error for ${orderId.slice(0, 8)}: ${e.message}`),
    );
  }
}

module.exports = { handlePayment };
