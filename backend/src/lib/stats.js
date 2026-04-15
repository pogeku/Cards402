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
//
// F5-stats (2026-04-15): added dedicated buckets for 'expired',
//   'rejected', and 'awaiting_approval'. Pre-fix these statuses were
//   counted in total_orders but not in any detail bucket, so the sum
//   of per-status fields was strictly less than total_orders whenever
//   any order was expired, rejected, or waiting on approval. A dashboard
//   that displays "breakdown by status" under-reported silently; an
//   operator couldn't tell how many orders were stuck in the approval
//   queue from the stats endpoint alone. The fix is additive — existing
//   fields keep their semantics; new fields are populated from the same
//   single aggregation query.
//
// F6-stats (2026-04-15): validate apiKeyIds is an array before touching
//   it. A caller passing a string (e.g. 'abc') used to crash with
//   `apiKeyIds.map is not a function` because strings have length but
//   no .map — a confusing TypeError leaking from deep inside the SQL
//   builder. Now throws a clear TypeError at the boundary.
//
// F7-stats (2026-04-15): cap apiKeyIds at MAX_SCOPE_IDS. SQLite's default
//   SQLITE_LIMIT_VARIABLE_NUMBER is 32766; a caller (or a hostile filter
//   feeding into the SQL builder) with 40k ids would crash the query
//   with a cryptic bind error after we'd already built a 1MB SQL string.
//   Cap at 1000 ids — far beyond any realistic dashboard scope — and
//   throw a clear RangeError before building the IN clause.

const db = require('../db');

// F7-stats: bounded scope size. A dashboard owner with the most api_keys
// today has < 20; 1000 leaves ~50x headroom and still bounds the worst-
// case SQL build cost.
const MAX_SCOPE_IDS = 1000;

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
    // F5-stats new buckets:
    expired: 0,
    rejected: 0,
    awaiting_approval: 0,
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
 *   expired: number,
 *   rejected: number,
 *   awaiting_approval: number,
 * }}
 */
function getOrderStats(opts = {}) {
  const { apiKeyIds } = opts;

  // F6-stats: validate shape before touching the array. Strings have a
  // `.length` property but no `.map`, so a caller passing 'abc' used to
  // fall through the empty-check and then crash inside `.map()` with a
  // confusing TypeError. Throw a clear error at the boundary instead.
  if (apiKeyIds !== undefined && !Array.isArray(apiKeyIds)) {
    throw new TypeError(
      `getOrderStats: apiKeyIds must be an array or undefined, got ${typeof apiKeyIds}`,
    );
  }

  // F2-stats: explicit empty-scope short-circuit. An empty array
  // means "stats for no keys" — return zero, not the platform total.
  if (apiKeyIds !== undefined && apiKeyIds.length === 0) {
    return emptyStats();
  }

  // F7-stats: cap scope size BEFORE building the SQL. SQLite's default
  // SQLITE_LIMIT_VARIABLE_NUMBER is 32766; beyond ~1k ids we'd be
  // burning memory on a multi-megabyte SQL string that SQLite will
  // reject anyway. Throwing here surfaces caller bugs or hostile
  // filter inputs with a clear error.
  if (apiKeyIds !== undefined && apiKeyIds.length > MAX_SCOPE_IDS) {
    throw new RangeError(
      `getOrderStats: apiKeyIds length ${apiKeyIds.length} exceeds MAX_SCOPE_IDS=${MAX_SCOPE_IDS}`,
    );
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
      COALESCE(SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END), 0) AS refund_pending,
      COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
      COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
      COALESCE(SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END), 0) AS awaiting_approval
    FROM orders ${where}
  `,
      )
      .get(...params)
  );
}

module.exports = { getOrderStats };
