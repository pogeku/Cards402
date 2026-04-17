// @ts-check
// MPP challenge lifecycle: create, load, atomic redeem.
//
// A challenge is the short-lived pre-order row that pairs a public
// GET /v1/cards/:product/:amount request with the Stellar tx that
// will eventually pay for it. Bounded TTL (default 10m) and nightly
// sweep in jobs.js keep the table from growing under unauthenticated
// traffic.

const crypto = require('crypto');
const db = require('../db');

const CHALLENGE_ID_PREFIX = 'mpp_c_';
const RECEIPT_ID_PREFIX = 'mpp_r_';

/**
 * Generate a new challenge id. 24 bytes of entropy encoded as base32
 * (5 bits per char → 39 chars) gives ample collision resistance for
 * an unauthenticated-write table. Prefix makes the id self-describing
 * and avoids any accidental collision with a raw UUID.
 */
function generateChallengeId() {
  return CHALLENGE_ID_PREFIX + crypto.randomBytes(24).toString('base64url');
}

/**
 * Generate a receipt id with the same entropy shape as challenges.
 * Receipt ids are the stable alias used in the 202+Location flow so
 * clients can poll a short URL instead of the opaque order uuid.
 */
function generateReceiptId() {
  return RECEIPT_ID_PREFIX + crypto.randomBytes(24).toString('base64url');
}

/**
 * @typedef {object} CreateChallengeOpts
 * @property {string} resourcePath - The URL path the client requested.
 * @property {string} amountUsdc - Decimal string, e.g. '10.00'.
 * @property {string|null} amountXlm - Quoted XLM amount at challenge time, or null if unquoted.
 * @property {string|null} clientIp - Source IP for forensic/rate-limit context.
 * @property {number} ttlMs - Milliseconds until expiry.
 */

/**
 * Insert a new challenge row. Returns the challenge record so the caller
 * can shape it into the 402 response body. The XLM quote is snapshotted
 * at creation time — a retry verifies against the snapshotted amount,
 * not a freshly-quoted price (which may have drifted).
 * @param {CreateChallengeOpts} opts
 */
function createChallenge(opts) {
  const id = generateChallengeId();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + opts.ttlMs);
  db.prepare(
    `INSERT INTO mpp_challenges
        (id, resource_path, amount_usdc, amount_xlm, client_ip, created_at, expires_at)
     VALUES (@id, @resource_path, @amount_usdc, @amount_xlm, @client_ip, @created_at, @expires_at)`,
  ).run({
    id,
    resource_path: opts.resourcePath,
    amount_usdc: opts.amountUsdc,
    amount_xlm: opts.amountXlm ?? null,
    client_ip: opts.clientIp,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
  return {
    id,
    resourcePath: opts.resourcePath,
    amountUsdc: opts.amountUsdc,
    amountXlm: opts.amountXlm ?? null,
    createdAt,
    expiresAt,
  };
}

/**
 * Load a challenge by id. Returns null if not found.
 * @param {string} id
 */
function loadChallenge(id) {
  if (typeof id !== 'string' || !id.startsWith(CHALLENGE_ID_PREFIX)) return null;
  const row = /** @type {any} */ (db.prepare(`SELECT * FROM mpp_challenges WHERE id = ?`).get(id));
  return row || null;
}

/**
 * Attempt to redeem a challenge with a Stellar tx hash. Atomic CAS so
 * concurrent retries against the same challenge can't double-redeem,
 * and the UNIQUE index on redeemed_tx_hash prevents the same tx from
 * redeeming two different challenges.
 *
 * Returns:
 *   { ok: true }                               — challenge is now redeemed against this tx
 *   { ok: false, reason: 'already_redeemed' }  — someone else won, or we already redeemed with a different tx
 *   { ok: false, reason: 'expired' }           — challenge expired before retry
 *   { ok: false, reason: 'not_found' }
 *   { ok: false, reason: 'tx_already_used' }   — this tx was already used against another challenge
 *
 * @param {{ id: string, txHash: string, orderId: string }} opts
 */
function redeemChallenge(opts) {
  const now = new Date().toISOString();
  // Wrap in a transaction so the existence/expiry check and the UPDATE
  // can't race another request in between.
  return db.transaction(() => {
    const row = /** @type {any} */ (
      db.prepare(`SELECT * FROM mpp_challenges WHERE id = ?`).get(opts.id)
    );
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.redeemed_at) {
      // Idempotent retry: same tx matching the same challenge is fine.
      if (row.redeemed_tx_hash === opts.txHash) return { ok: true, idempotent: true };
      return { ok: false, reason: 'already_redeemed' };
    }
    if (row.expires_at <= now) return { ok: false, reason: 'expired' };

    try {
      const result = db
        .prepare(
          `UPDATE mpp_challenges
             SET redeemed_at = @now,
                 redeemed_tx_hash = @tx_hash,
                 order_id = @order_id
           WHERE id = @id AND redeemed_at IS NULL`,
        )
        .run({ now, tx_hash: opts.txHash, order_id: opts.orderId, id: opts.id });
      if (result.changes === 0) return { ok: false, reason: 'already_redeemed' };
    } catch (err) {
      const e = /** @type {any} */ (err);
      // better-sqlite3 exposes code = 'SQLITE_CONSTRAINT_UNIQUE' on UNIQUE
      // violations; also fall back to the message pattern in case the
      // driver ever changes.
      const msg = e?.message || '';
      if (
        e?.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        /redeemed_tx_hash|idx_mpp_challenges_tx_hash/.test(msg)
      ) {
        return { ok: false, reason: 'tx_already_used' };
      }
      throw err;
    }
    return { ok: true };
  })();
}

/**
 * Associate a receipt id with a redeemed challenge. Called after the
 * order row is inserted so the receipt endpoint can resolve id → order.
 * @param {{ challengeId: string, receiptId: string }} opts
 */
function attachReceiptId(opts) {
  db.prepare(`UPDATE orders SET mpp_receipt_id = ? WHERE mpp_challenge_id = ?`).run(
    opts.receiptId,
    opts.challengeId,
  );
}

/**
 * Load an order by receipt id. Returns the full orders row or null.
 * @param {string} receiptId
 */
function loadOrderByReceiptId(receiptId) {
  if (typeof receiptId !== 'string' || !receiptId.startsWith(RECEIPT_ID_PREFIX)) return null;
  const row = /** @type {any} */ (
    db.prepare(`SELECT * FROM orders WHERE mpp_receipt_id = ?`).get(receiptId)
  );
  return row || null;
}

/**
 * Sweep expired, never-redeemed challenges older than 24h. Keeps the
 * table bounded under sustained unauthenticated traffic. Redeemed rows
 * are kept forever as an audit trail (small volume; they point at the
 * real orders row).
 */
function sweepExpiredChallenges() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare(`DELETE FROM mpp_challenges WHERE redeemed_at IS NULL AND expires_at < ?`)
    .run(cutoff);
  return { deleted: result.changes };
}

module.exports = {
  CHALLENGE_ID_PREFIX,
  RECEIPT_ID_PREFIX,
  generateChallengeId,
  generateReceiptId,
  createChallenge,
  loadChallenge,
  redeemChallenge,
  attachReceiptId,
  loadOrderByReceiptId,
  sweepExpiredChallenges,
};
