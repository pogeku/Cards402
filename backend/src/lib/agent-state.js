// @ts-check
// Derives the public "agent_state" value shown in the dashboard from an
// api_keys row plus its order history. The stored column only holds
// explicitly-reported transient states ('initializing', 'awaiting_funding').
// 'minted' and 'active' are computed on every read so they never drift.
//
// Terminal ordering:
//   minted            — no last_used_at, no activity
//   initializing      — reported by the agent as it spins up
//   awaiting_funding  — reported by the agent after wallet creation
//   active            — at least one delivered order

const db = require('../db');

const STATE_LABELS = {
  minted: 'Minted',
  initializing: 'Setting up',
  awaiting_funding: 'Awaiting deposit',
  active: 'Active',
};

/**
 * Compute the display state for an api_keys row.
 * @param {any} key — an api_keys row (must include id, agent_state, last_used_at)
 * @returns {{ state: string, label: string, detail: string|null, since: string|null, wallet_public_key: string|null }}
 */
function deriveAgentState(key) {
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
  const delivered = /** @type {any} */ (
    db
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE api_key_id = ? AND status = 'delivered'`)
      .get(key.id)
  );
  if (delivered && delivered.n > 0) {
    return {
      state: 'active',
      label: STATE_LABELS.active,
      detail: `${delivered.n} delivered`,
      since: key.agent_state_at ?? key.last_used_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  // Explicitly-reported transient states take precedence over 'minted'.
  if (key.agent_state === 'initializing' || key.agent_state === 'awaiting_funding') {
    return {
      state: key.agent_state,
      label: STATE_LABELS[key.agent_state],
      detail: key.agent_state_detail ?? null,
      since: key.agent_state_at ?? null,
      wallet_public_key: key.wallet_public_key ?? null,
    };
  }

  // Default: minted. last_used_at may still be set if the agent called
  // /v1/usage or /v1/orders without ever reporting a transition —
  // keep it as a soft indicator but leave the state as 'minted'.
  return {
    state: 'minted',
    label: STATE_LABELS.minted,
    detail: null,
    since: key.last_used_at ?? null,
    wallet_public_key: key.wallet_public_key ?? null,
  };
}

module.exports = { deriveAgentState, STATE_LABELS };
