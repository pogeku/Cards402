// @ts-check
// Shared order-stats query builder. Used by internal.js to avoid
// duplicating the same COUNT/SUM aggregation. Audit A-18.
//
// Adversarial audit (2026-04-15):
//
// F1-stats: total_gmv used to sum EVERY order amount regardless of
//   status, inflating GMV with failed / expired / rejected / refunded
//   orders that never represented money flowing to a card. Now
//   scoped to status='delivered' so the number means "money that
//   actually reached a card". Refunded orders are excluded (the
//   money was returned to the agent — net zero). Operators wanting
//   the broader "attempted" view can compute it from the status
//   counts.
//
// F2-stats: an empty apiKeyIds array (apiKeyIds: []) used to fall
//   through the `apiKeyIds.length > 0` guard and return the GLOBAL
//   platform totals — a cross-tenant data leak if a caller's filter
//   resolved to zero keys (empty-result UI bug, user with zero owned
//   keys, etc.). Now returns a zero-valued result without hitting
//   the DB when the scope is explicitly empty.
//
// F3-stats: SUM(CASE WHEN...) over an empty table returns NULL in
//   SQLite, not 0. Only total_gmv had COALESCE; the other counters
//   leaked null back to callers which then got NaN on arithmetic.
//   Every SUM is now COALESCE-wrapped.
//
// F4-stats: added an in_progress bucket covering the ordering-family
//   statuses that /status already tracks. Callers no longer have to
//   replicate the status list.

const db = require('../db');

/**
 * Zero-valued result, returned when the caller's scope resolves to
 * an empty set (apiKeyIds: []). Keeping the shape in one place makes
 * it obvious that "scoped to nothing" and "no orders exist" return
 * identical results.
 */
function emptyStats() {
  return {
    total_orders: 0,
    total_gmv: 0,
    delivered: 0,
    failed: 0,
    refunded: 0,
    pending: 0,
    in_progress: 0,
    refund_pending: 0,
  };
}

/**
 * Aggregate order stats, optionally scoped to a set of API key IDs.
 *
 * total_gmv is the sum of amount_usdc across DELIVERED orders only —
 * the number that represents money flowing to cards. See the F1
 * audit note above for rationale.
 *
 * @param {{ apiKeyIds?: string[] }} [opts]
 * @returns {{
 *   total_orders: number,
 *   total_gmv: number,
 *   delivered: number,
 *   failed: number,
 *   refunded: number,
 *   pending: number,
 *   in_progress: number,
 *   refund_pending: number,
 * }}
 */
function getOrderStats(opts = {}) {
  const { apiKeyIds } = opts;

  // F2-stats: explicit empty-scope short-circuit. An empty array
  // means "stats for no keys" — return zero, not the platform total.
  if (apiKeyIds !== undefined && apiKeyIds.length === 0) {
    return emptyStats();
  }

  let where = '';
  /** @type {any[]} */
  const params = [];

  if (apiKeyIds && apiKeyIds.length > 0) {
    const placeholders = apiKeyIds.map(() => '?').join(',');
    where = `WHERE api_key_id IN (${placeholders})`;
    params.push(...apiKeyIds);
  }

  return /** @type {any} */ (
    db
      .prepare(
        `
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN CAST(amount_usdc AS REAL) ELSE 0 END), 0) AS total_gmv,
      COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunded,
      COALESCE(SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status IN ('ordering','payment_confirmed','claim_received','stage1_done') THEN 1 ELSE 0 END), 0) AS in_progress,
      COALESCE(SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END), 0) AS refund_pending
    FROM orders ${where}
  `,
      )
      .get(...params)
  );
}

module.exports = { getOrderStats };
