// @ts-check
// Shared order-stats query builder. Used by admin.js, dashboard.js, and
// internal.js to avoid duplicating the same COUNT/SUM aggregation.
// Audit A-18.

const db = require('../db');

/**
 * Aggregate order stats, optionally scoped to a set of API key IDs.
 *
 * @param {{ apiKeyIds?: string[] }} [opts]
 * @returns {{
 *   total_orders: number,
 *   total_gmv: number,
 *   delivered: number,
 *   failed: number,
 *   refunded: number,
 *   pending: number,
 *   refund_pending: number,
 * }}
 */
function getOrderStats(opts = {}) {
  const { apiKeyIds } = opts;
  let where = '';
  /** @type {any[]} */
  const params = [];

  if (apiKeyIds && apiKeyIds.length > 0) {
    const placeholders = apiKeyIds.map(() => '?').join(',');
    where = `WHERE api_key_id IN (${placeholders})`;
    params.push(...apiKeyIds);
  }

  return /** @type {any} */ (db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total_gmv,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END) AS refund_pending
    FROM orders ${where}
  `).get(...params));
}

module.exports = { getOrderStats };
