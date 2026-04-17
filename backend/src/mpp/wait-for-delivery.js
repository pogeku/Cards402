// @ts-check
// Bounded wait for an order to reach a terminal state.
//
// MPP wants a single HTTP roundtrip where possible — the client has paid,
// the server verifies, and the card comes back in the 200. Card
// fulfillment (CTX invoice + payment + scrape + VCC callback) typically
// completes in ~5-30s after handlePayment dispatches, but we can't block
// indefinitely without triggering reverse-proxy timeouts. If the order
// is ready inside the bounded window we return it; otherwise the caller
// hands off to a 202 + Location response pointing at the receipt URL.

const db = require('../db');

const POLL_INTERVAL_MS = 250;

/**
 * Wait up to `timeoutMs` for order `orderId` to reach a terminal state.
 * Poll-based so the pattern is identical to /v1/orders/:id/stream and
 * requires no new infrastructure. The polling interval is short (250ms)
 * because this is the happy path for latency-sensitive clients.
 *
 * Returns:
 *   { state: 'delivered', order } — card details are populated on the row
 *   { state: 'failed', order }    — fulfillment failed; caller returns 4xx/5xx
 *   { state: 'timeout', order }   — still fulfilling; caller returns 202
 *
 * @param {{ orderId: string, timeoutMs: number }} opts
 */
async function waitForDelivery({ orderId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  // Check once immediately — the happy path where the order is already
  // delivered by the time we start polling (e.g. watcher + MPP race).
  let order = loadOrder(orderId);
  if (order && isTerminal(order)) {
    return { state: classify(order), order };
  }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    order = loadOrder(orderId);
    if (order && isTerminal(order)) {
      return { state: classify(order), order };
    }
  }
  return { state: 'timeout', order: order ?? null };
}

function loadOrder(orderId) {
  return /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));
}

function isTerminal(order) {
  return order.status === 'delivered' || order.status === 'failed';
}

function classify(order) {
  return order.status === 'delivered' ? 'delivered' : 'failed';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { waitForDelivery };
