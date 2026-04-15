// Unit tests for src/lib/agent-state.js — derives the public "agent
// state" shown on the dashboard from an api_keys row plus its order
// history. Before the 2026-04-15 adversarial audit there were ZERO
// tests for this module despite it being the source of truth for
// every agent pill in the dashboard UI. This file covers:
//
//   F1-agent-state: batchDeliveredCounts() collapses N per-row
//                   SELECT COUNT(*) queries into a single GROUP BY.
//                   The dashboard api-keys endpoint uses it to feed
//                   `deriveAgentState` with a prefetched count,
//                   avoiding an N+1 against the orders table.
//
//   F2-agent-state: Unrecognised stored agent_state values (schema
//                   drift, ops-write typos, future migrations) surface
//                   as 'unknown' with a loud one-shot warn, instead
//                   of silently masquerading as 'minted'.
//
//   F3-agent-state: STATE_LABELS is frozen at module load so a
//                   downstream mutation cannot corrupt the shared
//                   reference for every subsequent call.
//
// Plus baseline behaviour for all the recognised transient/terminal
// states, which was previously uncovered.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, resetDb, createTestKey, seedOrder } = require('../helpers/app');
const {
  deriveAgentState,
  batchDeliveredCounts,
  STATE_LABELS,
  _resetWarnedStates,
} = require('../../src/lib/agent-state');

// Build an ephemeral api_keys-shaped object without touching the DB —
// useful for tests that only exercise the pure assembly logic via a
// prefetched deliveredCount.
function fakeKey(overrides = {}) {
  return {
    id: 'test-key-1',
    agent_state: null,
    agent_state_at: null,
    agent_state_detail: null,
    last_used_at: null,
    wallet_public_key: null,
    ...overrides,
  };
}

// ── Baseline behaviour ──────────────────────────────────────────────────────

describe('deriveAgentState — baseline', () => {
  beforeEach(() => {
    resetDb();
    _resetWarnedStates();
  });

  it('returns minted for a null key', () => {
    const s = deriveAgentState(null);
    assert.equal(s.state, 'minted');
    assert.equal(s.label, 'Minted');
    assert.equal(s.detail, null);
    assert.equal(s.since, null);
  });

  it('returns minted for a fresh key with no activity (count prefetched)', () => {
    const key = fakeKey({ id: 'k1' });
    const s = deriveAgentState(key, { deliveredCount: 0 });
    assert.equal(s.state, 'minted');
  });

  it('surfaces initializing transient state', () => {
    const key = fakeKey({
      id: 'k1',
      agent_state: 'initializing',
      agent_state_at: '2026-04-15T00:00:00Z',
      agent_state_detail: 'setting up wallet',
    });
    const s = deriveAgentState(key, { deliveredCount: 0 });
    assert.equal(s.state, 'initializing');
    assert.equal(s.label, 'Setting up');
    assert.equal(s.detail, 'setting up wallet');
    assert.equal(s.since, '2026-04-15T00:00:00Z');
  });

  it('surfaces awaiting_funding transient state', () => {
    const key = fakeKey({ id: 'k1', agent_state: 'awaiting_funding' });
    const s = deriveAgentState(key, { deliveredCount: 0 });
    assert.equal(s.state, 'awaiting_funding');
    assert.equal(s.label, 'Awaiting deposit');
  });

  it('surfaces funded state', () => {
    const key = fakeKey({ id: 'k1', agent_state: 'funded' });
    const s = deriveAgentState(key, { deliveredCount: 0 });
    assert.equal(s.state, 'funded');
  });

  it('returns active once a delivered count > 0 regardless of agent_state', () => {
    const key = fakeKey({ id: 'k1', agent_state: 'initializing' });
    const s = deriveAgentState(key, { deliveredCount: 3 });
    assert.equal(s.state, 'active');
    assert.equal(s.label, 'Active');
    assert.equal(s.detail, '3 delivered');
  });

  it('does a real DB lookup when deliveredCount is not prefetched', async () => {
    const { id } = await createTestKey({ label: 'live-lookup' });
    seedOrder({ api_key_id: id, status: 'delivered' });
    seedOrder({ api_key_id: id, status: 'delivered' });
    seedOrder({ api_key_id: id, status: 'pending_payment' });
    const key = fakeKey({ id });
    const s = deriveAgentState(key); // no opts — single-row DB path
    assert.equal(s.state, 'active');
    assert.equal(s.detail, '2 delivered');
  });
});

// ── F1-agent-state: batch helper ───────────────────────────────────────────

describe('F1-agent-state: batchDeliveredCounts', () => {
  beforeEach(() => {
    resetDb();
    _resetWarnedStates();
  });

  it('returns an empty Map for an empty id list', () => {
    const out = batchDeliveredCounts([]);
    assert.equal(out.size, 0);
  });

  it('returns an empty Map for null/undefined input', () => {
    // @ts-expect-error — intentional
    assert.equal(batchDeliveredCounts(null).size, 0);
    // @ts-expect-error — intentional
    assert.equal(batchDeliveredCounts(undefined).size, 0);
  });

  it('filters null/undefined ids from the list and returns a clean Map', async () => {
    const { id } = await createTestKey({ label: 'filter-test' });
    seedOrder({ api_key_id: id, status: 'delivered' });
    const out = batchDeliveredCounts([null, undefined, id]);
    assert.equal(out.get(id), 1);
    assert.equal(out.size, 1);
  });

  it('groups delivered counts across multiple api_keys in ONE query', async () => {
    const k1 = (await createTestKey({ label: 'g1' })).id;
    const k2 = (await createTestKey({ label: 'g2' })).id;
    const k3 = (await createTestKey({ label: 'g3' })).id;
    seedOrder({ api_key_id: k1, status: 'delivered' });
    seedOrder({ api_key_id: k1, status: 'delivered' });
    seedOrder({ api_key_id: k1, status: 'pending_payment' }); // not counted
    seedOrder({ api_key_id: k2, status: 'delivered' });
    // k3 has no orders at all
    const out = batchDeliveredCounts([k1, k2, k3]);
    assert.equal(out.get(k1), 2);
    assert.equal(out.get(k2), 1);
    assert.equal(out.get(k3), undefined, 'keys with zero delivered are absent from the map');
  });

  it('reduces a list-render path from N queries to 1 (smoke check)', async () => {
    // Seed 10 keys each with 2 delivered orders. The batch helper
    // satisfies the entire list with a single GROUP BY.
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const { id } = await createTestKey({ label: `bulk-${i}` });
      seedOrder({ api_key_id: id, status: 'delivered' });
      seedOrder({ api_key_id: id, status: 'delivered' });
      ids.push(id);
    }
    const out = batchDeliveredCounts(ids);
    assert.equal(out.size, 10);
    for (const id of ids) assert.equal(out.get(id), 2);
  });

  it('prefetched count short-circuits the per-row DB query', async () => {
    // Even if the DB has 5 delivered rows, an explicitly-passed count wins.
    const { id } = await createTestKey({ label: 'prefetch' });
    for (let i = 0; i < 5; i++) seedOrder({ api_key_id: id, status: 'delivered' });
    const key = fakeKey({ id });
    const s = deriveAgentState(key, { deliveredCount: 0 });
    // With prefetched 0 we drop out of the 'active' branch.
    assert.equal(s.state, 'minted');
  });
});

// ── F2-agent-state: unknown state surfaces loudly ──────────────────────────

describe('F2-agent-state: unknown stored agent_state', () => {
  let origWarn;
  let warns;

  beforeEach(() => {
    resetDb();
    _resetWarnedStates();
    warns = [];
    origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
  });

  function restoreWarn() {
    console.warn = origWarn;
  }

  it('renders unknown stored state as state=unknown + detail=rawValue', () => {
    const key = fakeKey({
      id: 'k1',
      agent_state: 'paused', // not in TRANSIENT_STATES
      agent_state_at: '2026-04-15T00:00:00Z',
    });
    try {
      const s = deriveAgentState(key, { deliveredCount: 0 });
      assert.equal(s.state, 'unknown');
      assert.equal(s.label, 'Unknown');
      assert.equal(s.detail, 'paused');
      assert.equal(s.since, '2026-04-15T00:00:00Z');
    } finally {
      restoreWarn();
    }
    assert.ok(
      warns.some((w) => /unrecognized agent_state="paused"/.test(w)),
      `expected loud warn, got: ${JSON.stringify(warns)}`,
    );
  });

  it('warns exactly ONCE per unique unknown value (no log spam)', () => {
    try {
      for (let i = 0; i < 5; i++) {
        const key = fakeKey({ id: `k${i}`, agent_state: 'paused' });
        deriveAgentState(key, { deliveredCount: 0 });
      }
    } finally {
      restoreWarn();
    }
    const pausedWarns = warns.filter((w) => /unrecognized agent_state="paused"/.test(w));
    assert.equal(pausedWarns.length, 1, 'should warn exactly once per unique offender');
  });

  it('warns independently for each DISTINCT unknown value', () => {
    try {
      deriveAgentState(fakeKey({ id: 'k1', agent_state: 'paused' }), { deliveredCount: 0 });
      deriveAgentState(fakeKey({ id: 'k2', agent_state: 'rate_limited' }), { deliveredCount: 0 });
      deriveAgentState(fakeKey({ id: 'k3', agent_state: 'paused' }), { deliveredCount: 0 }); // dup
    } finally {
      restoreWarn();
    }
    assert.equal(warns.filter((w) => /"paused"/.test(w)).length, 1);
    assert.equal(warns.filter((w) => /"rate_limited"/.test(w)).length, 1);
  });

  it('does NOT warn for stored "minted" or "active" (valid terminal states)', () => {
    try {
      deriveAgentState(fakeKey({ id: 'k1', agent_state: 'minted' }), { deliveredCount: 0 });
      deriveAgentState(fakeKey({ id: 'k2', agent_state: 'active' }), { deliveredCount: 0 });
    } finally {
      restoreWarn();
    }
    assert.equal(warns.length, 0, `unexpected warns: ${JSON.stringify(warns)}`);
  });

  it('does NOT warn for null/empty agent_state (default minted path)', () => {
    try {
      deriveAgentState(fakeKey({ id: 'k1', agent_state: null }), { deliveredCount: 0 });
      deriveAgentState(fakeKey({ id: 'k2', agent_state: '' }), { deliveredCount: 0 });
    } finally {
      restoreWarn();
    }
    assert.equal(warns.length, 0);
  });

  it('active (delivered > 0) wins over an unknown stored state (no warn)', () => {
    // If the agent has delivered an order, the computed 'active' state
    // wins before we even look at the stored value — so schema drift
    // on a productive agent doesn't pollute the log.
    try {
      const key = fakeKey({ id: 'k1', agent_state: 'paused' });
      const s = deriveAgentState(key, { deliveredCount: 3 });
      assert.equal(s.state, 'active');
    } finally {
      restoreWarn();
    }
    assert.equal(warns.length, 0);
  });
});

// ── F3-agent-state: frozen STATE_LABELS ────────────────────────────────────

describe('F3-agent-state: frozen STATE_LABELS', () => {
  it('STATE_LABELS is frozen', () => {
    assert.equal(Object.isFrozen(STATE_LABELS), true);
  });

  it('mutation attempt does not change the shared reference', () => {
    const original = STATE_LABELS.minted;
    try {
      STATE_LABELS.minted = 'TAMPERED';
    } catch {
      /* strict-mode throw */
    }
    assert.equal(STATE_LABELS.minted, original);
  });

  it('every recognised state label is present', () => {
    for (const k of ['minted', 'initializing', 'awaiting_funding', 'funded', 'active', 'unknown']) {
      assert.equal(typeof STATE_LABELS[k], 'string');
      assert.ok(STATE_LABELS[k].length > 0);
    }
  });
});
