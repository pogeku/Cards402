// @ts-check
// Derives the public "agent_state" value shown in the dashboard from an
// api_keys row plus its order history. The stored column only holds
// explicitly-reported transient states ('initializing', 'awaiting_funding',
// 'funded'). 'minted' and 'active' are computed on every read so they
// never drift.
//
// Terminal ordering:
//   minted            — no last_used_at, no activity
//   initializing      — reported by the agent as it spins up
//   awaiting_funding  — reported by the agent after wallet creation
//   funded            — set by jobs.js::checkAgentFundingStatus once the
//                       Horizon poller sees a usable balance
//   active            — at least one delivered order
//   unknown           — stored state value not recognised by this module
//                       (F2-agent-state): surfaced instead of silently
//                       masquerading as 'minted', with a loud one-shot
//                       warn so schema drift is visible.

const db = require('../db');

// F3-agent-state (2026-04-15): freeze the label map at module load so a
// downstream mutation cannot corrupt the shared reference. Same shared-
// state hardening as sanitize-error / logger / event-bus.
const STATE_LABELS = Object.freeze({
  minted: 'Minted',
  initializing: 'Setting up',
  awaiting_funding: 'Awaiting deposit',
  funded: 'Funded',
  active: 'Active',
  unknown: 'Unknown',
});

// Set of stored agent_state values this module recognises as transient.
// Anything outside this set AND outside {minted, active} is a stored
// value we don't understand and gets the F2 'unknown' treatment.
const TRANSIENT_STATES = new Set(['initializing', 'awaiting_funding', 'funded']);

// F2-agent-state: dedup unknown-state warnings. A single api_keys row
// with a corrupt value would otherwise spam the log on every dashboard
// render. One warn per unique stored value per process lifetime is
// enough for ops visibility; operators can check logs or a DB query
// to enumerate affected rows.
const _warnedUnknownStates = new Set();

/**
 * Prepared statement for the single-row delivered-count path. Kept at
 * module level so better-sqlite3 can reuse the plan.
 */
const _singleCountStmt = db.prepare(
  `SELECT COUNT(*) AS n FROM orders WHERE api_key_id = ? AND status = 'delivered'`,
);

/**
 * Internal: assemble the agent-state envelope given a pre-computed
 * delivered count. Pure function of (key, count) — no DB access.
 *
 * @param {any} key
 * @param {number} deliveredCount
 */
function _assemble(key, deliveredCount) {
  if (!key) {
    return {
      state: 'minted',
      label: STATE_LABELS.minted,
      detail: null,
      since: null,
      wallet_public_key: null,
    };
  }

  // 'active' wins once any order has been delivered — keeps the state
  // honest even if the agent stopped reporting after setup.
  if (deliveredCount > 0) {
    return {
      state: 'active',
      label: STATE_LABELS.active,
      detail: `${deliveredCount} delivered`,
      since: key.agent_state_at ?? key.last_used_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  // Explicitly-reported transient states take precedence over 'minted'.
  if (TRANSIENT_STATES.has(key.agent_state)) {
    return {
      state: key.agent_state,
      label: STATE_LABELS[key.agent_state],
      detail: key.agent_state_detail ?? null,
      since: key.agent_state_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  // F2-agent-state: a truthy stored value that's NOT in the transient
  // set AND NOT one of the computed terminal states ('minted', 'active')
  // is schema drift or ops-write junk. Pre-fix, this silently rendered
  // as 'minted' and the dashboard gave ops no signal that a new state
  // had been introduced by migration or by a buggy writer. Surface as
  // 'unknown' with the raw value as detail, and console.warn once per
  // unique offender so the log isn't spammed by a hundred-row dashboard.
  if (key.agent_state && key.agent_state !== 'minted' && key.agent_state !== 'active') {
    const rawValue = String(key.agent_state);
    if (!_warnedUnknownStates.has(rawValue)) {
      console.warn(
        `[agent-state] unrecognized agent_state=${JSON.stringify(rawValue)} ` +
          `(first seen on api_key_id=${key.id}) — rendering as 'unknown'. ` +
          `Add it to TRANSIENT_STATES or clean the row.`,
      );
      _warnedUnknownStates.add(rawValue);
    }
    return {
      state: 'unknown',
      label: STATE_LABELS.unknown,
      detail: rawValue,
      since: key.agent_state_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  // Default: minted. last_used_at may still be set if the agent called
  // /v1/usage or /v1/orders without ever reporting a transition — keep
  // it as a soft indicator but leave the state as 'minted'.
  return {
    state: 'minted',
    label: STATE_LABELS.minted,
    detail: null,
    since: key.last_used_at ?? null,
    wallet_public_key: key.wallet_public_key ?? null,
  };
}

/**
 * Batched delivered-count lookup for a list of api_keys ids.
 *
 * F1-agent-state (2026-04-15): the dashboard api-keys endpoint used to
 * call `deriveAgentState` once per row, which fired one SELECT COUNT(*)
 * per api_key — N+1 against a table that grows with every order. For a
 * 100-agent dashboard that's 100 sequential queries against a growing
 * index, when a single GROUP BY suffices. Callers that know they'll
 * derive states for multiple rows should prefetch once with this helper
 * and thread the per-id count into `deriveAgentState(key, { deliveredCount })`.
 *
 * Returns a Map<api_key_id, deliveredCount>. Missing ids (no delivered
 * orders) are absent from the map — callers should default to 0.
 *
 * @param {Array<string|number>} ids
 * @returns {Map<string|number, number>}
 */
function batchDeliveredCounts(ids) {
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;
  const clean = ids.filter((id) => id !== null && id !== undefined);
  if (clean.length === 0) return out;
  const placeholders = clean.map(() => '?').join(',');
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT api_key_id, COUNT(*) AS n
         FROM orders
         WHERE api_key_id IN (${placeholders}) AND status = 'delivered'
         GROUP BY api_key_id`,
      )
      .all(...clean)
  );
  for (const r of rows) out.set(r.api_key_id, r.n);
  return out;
}

/**
 * Compute the display state for an api_keys row.
 *
 * For single-row lookups, this fires one DB query. For list rendering,
 * prefer `batchDeliveredCounts()` + pass `{ deliveredCount }` to
 * short-circuit the per-row query — see F1-agent-state note.
 *
 * @param {any} key — an api_keys row (must include id, agent_state, last_used_at)
 * @param {{ deliveredCount?: number }} [opts]
 * @returns {{ state: string, label: string, detail: string|null, since: string|null, wallet_public_key: string|null }}
 */
function deriveAgentState(key, opts = {}) {
  if (!key) return _assemble(null, 0);
  let deliveredCount;
  if (typeof opts.deliveredCount === 'number' && Number.isFinite(opts.deliveredCount)) {
    deliveredCount = opts.deliveredCount;
  } else {
    const row = /** @type {any} */ (_singleCountStmt.get(key.id));
    deliveredCount = row?.n ?? 0;
  }
  return _assemble(key, deliveredCount);
}

/**
 * Test-only: reset the warn-dedup cache so each test starts fresh.
 * Not part of the public contract.
 */
function _resetWarnedStates() {
  _warnedUnknownStates.clear();
}

module.exports = {
  deriveAgentState,
  batchDeliveredCounts,
  STATE_LABELS,
  _resetWarnedStates,
};
