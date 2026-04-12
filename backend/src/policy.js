// @ts-check
// Policy engine — evaluates spend controls before any card is issued.
//
// Every transaction passes through checkPolicy() before an order is created.
// All decisions (approved, blocked, pending_approval) are logged to policy_decisions.
//
// Rule evaluation order (first match wins):
//   1. suspended          — hard block, immediate
//   2. single_tx_hard_cap — amount exceeds per-transaction ceiling
//   3. after_hours        — outside allowed time window (UTC)
//   4. blocked_day        — outside allowed days of week
//   5. daily_limit        — would exceed today's spend cap
//   6. approval_threshold — amount above soft threshold → route to human
//   7. approved           — all checks passed

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { event: bizEvent } = require('./lib/logger');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Evaluate all policy rules for a proposed transaction.
 *
 * @param {string} apiKeyId
 * @param {string} amountUsdc  decimal string, e.g. "250.00"
 * @returns {{ decision: 'approved'|'blocked'|'pending_approval', rule: string, reason: string }}
 */
function checkPolicy(apiKeyId, amountUsdc) {
  const key = /** @type {any} */ (db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId));
  if (!key)
    return _decide(apiKeyId, null, amountUsdc, 'blocked', 'key_not_found', 'API key not found');

  const amount = parseFloat(amountUsdc);

  // ── 1. Suspension (immediate hard block) ────────────────────────────────────
  if (key.suspended) {
    return _decide(
      apiKeyId,
      null,
      amountUsdc,
      'blocked',
      'suspended',
      'This agent is suspended by the account owner.',
    );
  }

  // ── 2. Single-transaction hard cap ──────────────────────────────────────────
  if (key.policy_single_tx_limit_usdc !== null && key.policy_single_tx_limit_usdc !== undefined) {
    const cap = parseFloat(key.policy_single_tx_limit_usdc);
    if (amount > cap) {
      return _decide(
        apiKeyId,
        null,
        amountUsdc,
        'blocked',
        'single_tx_hard_cap',
        `Transaction $${amount.toFixed(2)} exceeds the per-transaction hard cap of $${cap.toFixed(2)}.`,
      );
    }
  }

  // ── 3. After-hours check (UTC) ───────────────────────────────────────────────
  //
  // Audit A-10: policy is validated at storage time by dashboard.js and
  // admin.js so a malformed value in the DB is a bug. Previous behavior
  // silently SKIPPED the check on parse failure — meaning a broken policy
  // acted like "no policy at all", which is the opposite of what the
  // operator intended. Now we FAIL CLOSED: block the transaction with a
  // specific reason so ops can tell the policy is corrupted, and emit an
  // error event so the bug surfaces in monitoring instead of being
  // swallowed.
  if (key.policy_allowed_hours) {
    try {
      const { start, end } = JSON.parse(key.policy_allowed_hours); // "HH:MM"
      if (typeof start !== 'string' || typeof end !== 'string') {
        throw new Error('start/end must be strings');
      }
      const now = new Date();
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
      const startMins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      // Handle overnight windows (e.g. 22:00–06:00)
      const inWindow =
        startMins <= endMins
          ? nowMins >= startMins && nowMins < endMins
          : nowMins >= startMins || nowMins < endMins;
      if (!inWindow) {
        const nowStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
        return _decide(
          apiKeyId,
          null,
          amountUsdc,
          'blocked',
          'after_hours',
          `Transactions are only allowed ${start}–${end} UTC. Current time: ${nowStr}.`,
        );
      }
    } catch (err) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_allowed_hours',
        error: err.message,
      });
      return _decide(
        apiKeyId,
        null,
        amountUsdc,
        'blocked',
        'policy_corrupt_hours',
        'Account policy (allowed hours) is misconfigured — contact support.',
      );
    }
  }

  // ── 4. Blocked day of week ───────────────────────────────────────────────────
  if (key.policy_allowed_days) {
    try {
      const allowed = JSON.parse(key.policy_allowed_days); // [0…6]
      if (!Array.isArray(allowed)) throw new Error('not an array');
      const today = new Date().getUTCDay();
      if (!allowed.includes(today)) {
        return _decide(
          apiKeyId,
          null,
          amountUsdc,
          'blocked',
          'blocked_day',
          `Transactions are not allowed on ${DAY_NAMES[today]}.`,
        );
      }
    } catch (err) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_allowed_days',
        error: err.message,
      });
      return _decide(
        apiKeyId,
        null,
        amountUsdc,
        'blocked',
        'policy_corrupt_days',
        'Account policy (allowed days) is misconfigured — contact support.',
      );
    }
  }

  // ── 5. Daily spend limit ─────────────────────────────────────────────────────
  if (key.policy_daily_limit_usdc !== null && key.policy_daily_limit_usdc !== undefined) {
    const dailyLimit = parseFloat(key.policy_daily_limit_usdc);
    // Count all orders created today except those that never received payment
    // ('expired' = payment window closed without payment, 'rejected' = blocked by policy).
    // Counting 'pending_payment' prevents TOCTOU races where concurrent orders
    // collectively exceed the limit before any one is confirmed.
    const row = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
      FROM orders
      WHERE api_key_id = ?
        AND status NOT IN ('expired', 'rejected')
        AND date(created_at) = date('now')
    `,
        )
        .get(apiKeyId)
    );
    const spentToday = parseFloat(row.total);
    if (spentToday + amount > dailyLimit) {
      return _decide(
        apiKeyId,
        null,
        amountUsdc,
        'blocked',
        'daily_limit_exceeded',
        `Daily limit of $${dailyLimit.toFixed(2)} would be exceeded. ` +
          `Spent today: $${spentToday.toFixed(2)}, requested: $${amount.toFixed(2)}.`,
      );
    }
  }

  // ── 6. Approval threshold (soft gate — routes to human) ─────────────────────
  if (
    key.policy_require_approval_above_usdc !== null &&
    key.policy_require_approval_above_usdc !== undefined
  ) {
    const threshold = parseFloat(key.policy_require_approval_above_usdc);
    if (amount > threshold) {
      // Don't log yet — caller will create the approval_request and log it
      return {
        decision: 'pending_approval',
        rule: 'approval_threshold',
        reason:
          `Transaction of $${amount.toFixed(2)} requires owner approval ` +
          `(threshold: $${threshold.toFixed(2)}).`,
      };
    }
  }

  // ── 7. All checks passed ─────────────────────────────────────────────────────
  return _decide(
    apiKeyId,
    null,
    amountUsdc,
    'approved',
    'all_checks_passed',
    'Transaction approved by policy.',
  );
}

/**
 * Record a policy decision in the audit log and return the result object.
 * Used internally and by callers who need to log a decision for an existing order.
 */
function recordDecision(apiKeyId, orderId, amountUsdc, decision, rule, reason) {
  db.prepare(
    `
    INSERT INTO policy_decisions (id, api_key_id, order_id, decision, rule, reason, amount_usdc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(uuidv4(), apiKeyId, orderId || null, decision, rule, reason, amountUsdc || null);
  return { decision, rule, reason };
}

// Internal: decide + log atomically
function _decide(apiKeyId, orderId, amountUsdc, decision, rule, reason) {
  return recordDecision(apiKeyId, orderId, amountUsdc, decision, rule, reason);
}

module.exports = { checkPolicy, recordDecision };
