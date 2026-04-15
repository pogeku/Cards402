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
 * The `persist` option controls whether the decision is logged to
 * policy_decisions. Default is `true` — the real order-creation path
 * relies on every decision being auditable. The preview endpoint
 * (GET /v1/policy/check) passes `persist: false` so a compromised or
 * buggy agent hitting the preview at the poll limit (600/min) can't
 * bloat the policy_decisions table with fake decision rows and can't
 * pollute post-incident forensic reconstruction with previews that
 * were never real orders. Adversarial audit finding F1-policy.
 *
 * @param {string} apiKeyId
 * @param {string} amountUsdc  decimal string, e.g. "250.00"
 * @param {{ persist?: boolean }} [opts]
 * @returns {{ decision: 'approved'|'blocked'|'pending_approval', rule: string, reason: string }}
 */
function checkPolicy(apiKeyId, amountUsdc, opts = {}) {
  const persist = opts.persist !== false;
  const finalise = (decision, rule, reason) =>
    persist
      ? _decide(apiKeyId, null, amountUsdc, decision, rule, reason)
      : { decision, rule, reason };

  const key = /** @type {any} */ (db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId));
  if (!key) return finalise('blocked', 'key_not_found', 'API key not found');

  // Defensive input validation. orders.js already rejects invalid amounts
  // before calling this, but checkPolicy is also exported for direct use
  // (tests, internal admin tools, future callers) and silent NaN / negative
  // handling bypasses every numeric rule below — NaN comparisons are always
  // false, so `amount > cap` returns false and the request is approved.
  // Fail-closed here so checkPolicy's contract doesn't depend on its callers.
  const amount = parseFloat(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    return finalise(
      'blocked',
      'invalid_amount',
      `Amount must be a positive finite number (got: ${amountUsdc}).`,
    );
  }

  // ── 1. Suspension (immediate hard block) ────────────────────────────────────
  if (key.suspended) {
    return finalise('blocked', 'suspended', 'This agent is suspended by the account owner.');
  }

  // ── 2. Single-transaction hard cap ──────────────────────────────────────────
  if (key.policy_single_tx_limit_usdc !== null && key.policy_single_tx_limit_usdc !== undefined) {
    const cap = parseFloat(key.policy_single_tx_limit_usdc);
    if (!Number.isFinite(cap) || cap < 0) {
      // Corrupt stored limit → fail closed. Same rationale as
      // policy_allowed_hours / policy_allowed_days below.
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_single_tx_limit_usdc',
        stored: String(key.policy_single_tx_limit_usdc),
      });
      return finalise(
        'blocked',
        'policy_corrupt_single_tx',
        'Account policy (per-transaction limit) is misconfigured — contact support.',
      );
    }
    if (amount > cap) {
      return finalise(
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
      // F1-policy adversarial audit (2026-04-15): strict HH:MM parsing.
      // The previous `.split(':').map(Number)` silently produced NaN
      // for inputs like "12:MM" / "24:00" / "12:70" / "-1:30" — all
      // passed the typeof-string check, all produced NaN or
      // out-of-range minute totals, and the subsequent inWindow math
      // could silently ALLOW transactions during a window that
      // doesn't exist. NaN < x is false, NaN comparisons short-circuit
      // the overnight-window branch, and a corrupted start/end was
      // effectively "no policy at all" — the exact failure mode this
      // section's comment claims to have eliminated.
      //
      // Enforcement: exact HH:MM regex (2 digits : 2 digits), integer
      // ranges hours ∈ [0,23] and minutes ∈ [0,59]. Any deviation
      // throws and routes through the existing fail-closed catch.
      const parseHHMM = (label, value) => {
        if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
          throw new Error(`${label} must be HH:MM (got: ${JSON.stringify(value)})`);
        }
        const [h, m] = value.split(':').map((s) => parseInt(s, 10));
        if (!Number.isInteger(h) || h < 0 || h > 23) {
          throw new Error(`${label} hour out of range 0-23 (got: ${h})`);
        }
        if (!Number.isInteger(m) || m < 0 || m > 59) {
          throw new Error(`${label} minute out of range 0-59 (got: ${m})`);
        }
        return h * 60 + m;
      };
      const startMins = parseHHMM('start', start);
      const endMins = parseHHMM('end', end);
      const now = new Date();
      const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
      // Handle overnight windows (e.g. 22:00–06:00)
      const inWindow =
        startMins <= endMins
          ? nowMins >= startMins && nowMins < endMins
          : nowMins >= startMins || nowMins < endMins;
      if (!inWindow) {
        const nowStr = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
        return finalise(
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
      return finalise(
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
      // F2-policy adversarial audit (2026-04-15): every entry must be
      // an integer in [0,6]. Previously the only check was Array.isArray,
      // so `["Tuesday", "Friday"]` passed the guard but the subsequent
      // `.includes(today)` with a numeric today would never match any
      // string entry → silently blocked every day. A shape like
      // `[0, 1, 2, "Friday", 5]` is worse: legit days present AND a
      // silently-ignored corrupt entry. Fail closed so operators see
      // a clear signal instead of a partial policy.
      for (const entry of allowed) {
        if (!Number.isInteger(entry) || entry < 0 || entry > 6) {
          throw new Error(`entry must be an integer in [0,6], got: ${JSON.stringify(entry)}`);
        }
      }
      const today = new Date().getUTCDay();
      if (!allowed.includes(today)) {
        return finalise(
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
      return finalise(
        'blocked',
        'policy_corrupt_days',
        'Account policy (allowed days) is misconfigured — contact support.',
      );
    }
  }

  // ── 5. Daily spend limit ─────────────────────────────────────────────────────
  if (key.policy_daily_limit_usdc !== null && key.policy_daily_limit_usdc !== undefined) {
    const dailyLimit = parseFloat(key.policy_daily_limit_usdc);
    if (!Number.isFinite(dailyLimit) || dailyLimit < 0) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_daily_limit_usdc',
        stored: String(key.policy_daily_limit_usdc),
      });
      return finalise(
        'blocked',
        'policy_corrupt_daily',
        'Account policy (daily limit) is misconfigured — contact support.',
      );
    }
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
      return finalise(
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
    if (!Number.isFinite(threshold) || threshold < 0) {
      bizEvent('policy.corrupt', {
        api_key_id: apiKeyId,
        field: 'policy_require_approval_above_usdc',
        stored: String(key.policy_require_approval_above_usdc),
      });
      return finalise(
        'blocked',
        'policy_corrupt_approval',
        'Account policy (approval threshold) is misconfigured — contact support.',
      );
    }
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
  return finalise('approved', 'all_checks_passed', 'Transaction approved by policy.');
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
