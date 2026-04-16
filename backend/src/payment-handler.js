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
// Import as module object so tests can monkey-patch xlmSender.payCtxOrder
// at runtime. Destructuring captures the reference at load time and
// prevents tests from exercising the ambiguous-outcome branch without
// a full patchCache refactor. Same pattern applied in jobs.js.
const xlmSender = require('./payments/xlm-sender');
const { scheduleRefund } = require('./fulfillment');
// Deferred logger reference so tests can monkey-patch `logger.event`
// at runtime without having to patchCache before module load. Same
// pattern used by src/middleware/requireCardReveal.js after the
// adversarial audit. The call sites below invoke through the module
// object (`logger.event(...)`) rather than a destructured local.
const logger = require('./lib/logger');
const { publicMessage } = require('./lib/sanitize-error');

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

/**
 * Parse a decimal-string amount as stroops, enforcing strict positivity.
 * Returns the BigInt stroops value if the string parses to a positive
 * number, or null if the string is empty / null / non-numeric / zero /
 * negative / contains garbage. Used by handlePayment to validate
 * order.amount_usdc before the comparison — see F2-payment-handler
 * below for the "corrupt amount becomes treasury drain" scenario.
 * @param {string|null|undefined} s
 * @returns {bigint|null}
 */
function parseStrictPositiveStroops(s) {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'string') return null;
  const str = s.trim();
  if (str.length === 0) return null;
  // Strict: digits, at most one dot, no sign. Reject anything else.
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  try {
    const v = toStroops(str);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * F1-payment-handler (2026-04-15): safe error-message extraction.
 * The outer fulfillment catch handler used to read `err.message` with
 * no defence — a non-Error thrown value (null, undefined, string, or
 * an Error with a getter-thrown `.message`) would crash the catch
 * block itself, skipping the "mark failed + schedule refund" cleanup
 * and leaving the order wedged in 'ordering' status until the
 * reconciler picked it up minutes later. Same helper pattern as
 * lib/retry.js::safeErrorMessage.
 * @param {unknown} err
 */
function safeErrorMessage(err) {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'string') return err;
  try {
    if (err instanceof Error && typeof err.message === 'string') return err.message;
    return String(err);
  } catch {
    return '<unstringifiable error>';
  }
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
    logger.event('payment.unmatched', {
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
  //
  // F2-payment-handler (2026-04-15): validate order.amount_usdc before
  // the comparison. Pre-fix, toStroops('') returned 0n, and any
  // positive on-chain payment compared as "overpayment of 0" → the
  // order transitioned to 'ordering' and we spent treasury fulfilling
  // a $0-quoted order. A corrupted / migration-broken / manually-edited
  // row with an empty or non-numeric amount_usdc became a treasury
  // drain vector. Fail closed: any row whose amount_usdc doesn't
  // strictly parse to a positive stroop value routes the incoming
  // event to unmatched_payments with reason='corrupt_order' and the
  // order stays in 'pending_payment' for ops to investigate.
  let excessUsdc = null;
  let excessXlm = null;
  if (paymentAsset === 'usdc_soroban') {
    const expected = order.amount_usdc;
    const expectedStroops = parseStrictPositiveStroops(expected);
    if (expectedStroops === null) {
      console.error(
        `[payment] order ${orderId.slice(0, 8)} has corrupt amount_usdc=${JSON.stringify(
          expected,
        )} — refusing to claim`,
      );
      logger.event('payment.corrupt_order_amount', {
        order_id: orderId,
        column: 'amount_usdc',
        raw_value: String(expected),
      });
      recordUnmatchedPayment({
        txid,
        senderAddress,
        paymentAsset,
        amountUsdc,
        amountXlm,
        orderId,
        reason: 'corrupt_order',
      });
      return;
    }
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
      // F3-payment-handler: symmetric overpayment signal. XLM already
      // emitted payment.xlm_overpaid — USDC was silent despite the
      // identical "buggy SDK over-paying" failure mode.
      logger.event('payment.usdc_overpaid', {
        order_id: orderId,
        expected_usdc: expected,
        paid_usdc: amountUsdc,
        excess_usdc: excessUsdc,
        txid,
      });
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
    logger.event('payment.xlm_overpaid', {
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
    // Extract the CTX invoice XLM amount from the payment URL for
    // margin tracking. Also snapshot the XLM/USD rate so the dashboard
    // can compute cost-of-sale in USD without a retrospective oracle.
    // Both are non-critical telemetry — if parsing or the price oracle
    // fails, the order still proceeds; the margin page just shows
    // "no data" for this row.
    let ctxInvoiceXlm = null;
    let settlementRate = null;
    try {
      const sender = require('./payments/xlm-sender');
      if (typeof sender.parseStellarPayUri === 'function') {
        const invoiceParsed = sender.parseStellarPayUri(paymentUrl);
        ctxInvoiceXlm = invoiceParsed.amount || null;
      }
    } catch {
      /* non-critical */
    }
    try {
      const { getXlmUsdPrice } = require('./payments/xlm-price');
      settlementRate = String(await getXlmUsdPrice());
    } catch {
      /* non-critical */
    }
    db.prepare(
      `UPDATE orders SET vcc_job_id = ?, callback_nonce = ?, ctx_invoice_xlm = ?,
       settlement_xlm_usd_rate = ?, updated_at = ? WHERE id = ?`,
    ).run(
      vccJobId,
      callbackNonce,
      ctxInvoiceXlm,
      settlementRate,
      new Date().toISOString(),
      orderId,
    );

    // Branch Stellar payment on what the agent paid us:
    //   - XLM → forward as-is from treasury (single-op payment)
    //   - USDC → two-op atomic tx (PathPaymentStrictSend into treasury
    //     + plain Payment forwarding the invoice XLM to CTX). See the
    //     sendUsdcAsXlm header for the 2026-04-14 bug that forced the
    //     split — CTX's payment watcher ignores path_payment_* ops.
    // order.amount_usdc is the USDC the agent paid (the order's USD
    // face value); it's the sendAmount ceiling on the strict-send side.
    //
    // Adversarial audit F1-jobs (2026-04-15): wrap payCtxOrder in an
    // inner try/catch so we can distinguish ambiguous outcomes
    // (stellarStatus='unknown' or 'applied_failed') from definitive
    // failures. xlm-sender now annotates submit throws with stellarStatus
    // and a pre-computed txHash; if we hit an ambiguous state here —
    // outbound CTX tx MAY have landed before the response was lost —
    // auto-scheduling a refund below would spend treasury twice: once
    // to CTX (maybe), once back to the agent (definitely). Park the
    // order instead and leave the reconcile path to bail via the
    // ctx_stellar_txid-IS-NOT-NULL filter in jobs.js.
    let ctxTxHash = null;
    try {
      ctxTxHash = await xlmSender.payCtxOrder(paymentUrl, {
        paymentAsset,
        maxUsdc: order.amount_usdc,
      });
    } catch (payErr) {
      const status = /** @type {any} */ (payErr)?.stellarStatus;
      const txHash = /** @type {any} */ (payErr)?.txHash;
      if ((status === 'unknown' || status === 'applied_failed') && txHash) {
        // Persist the hash, mark failed with a specific error, and
        // DO NOT call scheduleRefund. Operators verify on-chain via
        // ctx_stellar_txid and either unpark for retry or manually
        // refund. The order is terminal-failed from the agent's POV
        // until ops clears the park.
        db.prepare(
          `UPDATE orders
           SET status = 'failed',
               error = ?,
               ctx_stellar_txid = ?,
               updated_at = ?
           WHERE id = ?`,
        ).run(publicMessage('ctx_payment_ambiguous'), txHash, new Date().toISOString(), orderId);
        logger.event('ctx.payment_ambiguous', {
          order_id: orderId,
          stellar_status: status,
          tx_hash: txHash,
          amount_usdc: order.amount_usdc,
          payment_asset: paymentAsset,
          error: /** @type {Error} */ (payErr)?.message,
        });
        console.error(
          `[payment] order ${orderId.slice(0, 8)} ctx payment AMBIGUOUS ` +
            `[${status}] hash=${txHash} — parked, NO auto-refund`,
        );
        return;
      }
      // Non-ambiguous failure: fall through to the outer catch which
      // marks failed + schedules refund as before.
      throw payErr;
    }

    // Successful payCtxOrder — capture the hash for forensics.
    db.prepare(
      `UPDATE orders SET xlm_sent_at = ?, ctx_stellar_txid = ?, updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), ctxTxHash || null, new Date().toISOString(), orderId);

    await notifyPaid(vccJobId);
    db.prepare(`UPDATE orders SET vcc_notified_at = ?, updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      new Date().toISOString(),
      orderId,
    );
  } catch (err) {
    // F1-payment-handler: safely extract a message regardless of what
    // was thrown. Pre-fix, `err.message` on a non-Error (null, string,
    // Error with thrown-getter message, etc.) would crash the catch
    // handler itself — leaving the order wedged in 'ordering' with no
    // refund scheduled until the reconciler picked it up minutes later.
    const rawMessage = safeErrorMessage(err);
    console.error(`[payment] order ${orderId.slice(0, 8)} fulfillment error: ${rawMessage}`);
    // publicMessage is already defensive (audit F2-sanitize wraps its
    // own coercion in try/catch) but we pass the safe string anyway so
    // the two modules don't depend on each other's internals.
    db.prepare(`UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(
      publicMessage(rawMessage),
      new Date().toISOString(),
      orderId,
    );
    scheduleRefund(orderId).catch((e) =>
      console.error(`[payment] refund error for ${orderId.slice(0, 8)}: ${safeErrorMessage(e)}`),
    );
  }
}

module.exports = {
  handlePayment,
  // Test-only exports for the 2026-04-15 audit hardening.
  _parseStrictPositiveStroops: parseStrictPositiveStroops,
  _safeErrorMessage: safeErrorMessage,
};
