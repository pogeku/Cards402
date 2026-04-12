// @ts-check
// Soroban payment event handler — factored out of index.js so integration
// tests can exercise the full pipeline (getInvoice → payCtxOrder → notifyPaid)
// without having to boot the Express server or the stellar watcher.
//
// On-chain flow:
//   1. Agent invokes pay_usdc / pay_xlm on the receiver contract.
//   2. backend/src/payments/stellar.js sees the event and calls handlePayment.
//   3. This module atomically claims the order (pending_payment → ordering)
//      and then runs the three vcc-client steps, persisting a checkpoint
//      after each one so the reconciler in jobs.js can recover from a mid-
//      flight crash without double-paying.

const db = require('./db');
const { getInvoice, notifyPaid } = require('./vcc-client');
const { payCtxOrder } = require('./payments/xlm-sender');
const { scheduleRefund } = require('./fulfillment');

async function handlePayment({ txid, paymentAsset, amountUsdc: _amountUsdc, amountXlm, senderAddress, orderId }) {
  const order = /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));
  if (!order || order.status !== 'pending_payment') return;

  const now = new Date().toISOString();

  // Atomic transition — guards against duplicate payment events for the same order
  const claimed = db.prepare(`
    UPDATE orders
    SET status = 'ordering', payment_asset = ?, stellar_txid = ?,
        sender_address = ?, payment_xlm_amount = ?, updated_at = ?
    WHERE id = ? AND status = 'pending_payment'
  `).run(paymentAsset, txid, senderAddress, amountXlm, now, orderId);

  if (claimed.changes === 0) return;

  try {
    const { vccJobId, paymentUrl, callbackNonce } = await getInvoice(orderId, order.amount_usdc, order.request_id);
    db.prepare(`UPDATE orders SET vcc_job_id = ?, callback_nonce = ?, updated_at = ? WHERE id = ?`)
      .run(vccJobId, callbackNonce, new Date().toISOString(), orderId);

    await payCtxOrder(paymentUrl);
    db.prepare(`UPDATE orders SET xlm_sent_at = ?, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), orderId);

    await notifyPaid(vccJobId);
    db.prepare(`UPDATE orders SET vcc_notified_at = ?, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), orderId);
  } catch (err) {
    console.error(`[payment] order ${orderId.slice(0, 8)} fulfillment error: ${err.message}`);
    db.prepare(`UPDATE orders SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .run(err.message, new Date().toISOString(), orderId);
    scheduleRefund(orderId).catch(e => console.error(`[payment] refund error for ${orderId.slice(0, 8)}: ${e.message}`));
  }
}

module.exports = { handlePayment };
