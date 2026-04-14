require('../helpers/env');

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { checkPolicy } = require('../../src/policy');
const { createTestKey, seedOrder, resetDb, db } = require('../helpers/app');

// ── suspended ─────────────────────────────────────────────────────────────────

describe('checkPolicy — suspended rule', () => {
  before(() => resetDb());

  it('blocks a suspended key immediately', async () => {
    const { id } = await createTestKey({ label: 'suspended-key' });
    db.prepare(`UPDATE api_keys SET suspended = 1 WHERE id = ?`).run(id);

    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'suspended');
  });
});

// ── single_tx_hard_cap ────────────────────────────────────────────────────────

describe('checkPolicy — single_tx_hard_cap rule', () => {
  before(() => resetDb());

  it('blocks when amount exceeds per-tx cap', async () => {
    const { id } = await createTestKey({ label: 'capped-key' });
    db.prepare(`UPDATE api_keys SET policy_single_tx_limit_usdc = ? WHERE id = ?`).run('50.00', id);

    const result = checkPolicy(id, '100.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'single_tx_hard_cap');
  });

  it('approves when amount equals the cap (boundary)', async () => {
    const { id } = await createTestKey({ label: 'capped-boundary-key' });
    db.prepare(`UPDATE api_keys SET policy_single_tx_limit_usdc = ? WHERE id = ?`).run('50.00', id);

    const result = checkPolicy(id, '50.00');
    assert.equal(result.decision, 'approved');
  });
});

// ── daily_limit_exceeded ──────────────────────────────────────────────────────

describe('checkPolicy — daily_limit_exceeded rule', () => {
  before(() => resetDb());

  it('blocks when new transaction would push total over daily limit', async () => {
    const { id } = await createTestKey({ label: 'daily-limit-key' });
    db.prepare(`UPDATE api_keys SET policy_daily_limit_usdc = ? WHERE id = ?`).run('100.00', id);

    // Seed two delivered orders totalling $160 today
    seedOrder({ api_key_id: id, status: 'delivered', amount_usdc: '80.00' });
    seedOrder({ api_key_id: id, status: 'delivered', amount_usdc: '80.00' });

    const result = checkPolicy(id, '30.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'daily_limit_exceeded');
  });

  it('approves when amount fits within remaining daily limit (boundary)', async () => {
    const { id } = await createTestKey({ label: 'daily-limit-boundary-key' });
    db.prepare(`UPDATE api_keys SET policy_daily_limit_usdc = ? WHERE id = ?`).run('100.00', id);

    // Seed one delivered order for $80
    seedOrder({ api_key_id: id, status: 'delivered', amount_usdc: '80.00' });

    // $80 + $20 = $100 — exactly at the limit, should approve (not strictly over)
    const result = checkPolicy(id, '20.00');
    assert.equal(result.decision, 'approved');
  });

  it('excludes only expired and rejected orders from daily total', async () => {
    const { id } = await createTestKey({ label: 'daily-limit-exclusion-key' });
    db.prepare(`UPDATE api_keys SET policy_daily_limit_usdc = ? WHERE id = ?`).run('200.00', id);

    // expired and rejected: agent never paid — must NOT count
    seedOrder({ api_key_id: id, status: 'expired', amount_usdc: '90.00' });
    seedOrder({ api_key_id: id, status: 'rejected', amount_usdc: '90.00' });

    // $90 * 2 excluded → $0 spent; $99 request should be approved
    const result = checkPolicy(id, '99.00');
    assert.equal(result.decision, 'approved');
  });

  it('counts failed and refunded orders toward daily total', async () => {
    const { id } = await createTestKey({ label: 'daily-limit-paid-key' });
    db.prepare(`UPDATE api_keys SET policy_daily_limit_usdc = ? WHERE id = ?`).run('100.00', id);

    // failed and refunded orders had payment received — must count toward limit
    seedOrder({ api_key_id: id, status: 'failed', amount_usdc: '60.00' });
    seedOrder({ api_key_id: id, status: 'refunded', amount_usdc: '30.00' });

    // $60 + $30 = $90 counted; $20 more would reach $110 > $100 limit
    const result = checkPolicy(id, '20.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'daily_limit_exceeded');
  });
});

// ── approval_threshold ────────────────────────────────────────────────────────

describe('checkPolicy — approval_threshold rule', () => {
  before(() => resetDb());

  it('returns pending_approval when amount strictly exceeds threshold', async () => {
    const { id } = await createTestKey({ label: 'approval-key' });
    db.prepare(`UPDATE api_keys SET policy_require_approval_above_usdc = ? WHERE id = ?`).run(
      '50.00',
      id,
    );

    const result = checkPolicy(id, '100.00');
    assert.equal(result.decision, 'pending_approval');
    assert.equal(result.rule, 'approval_threshold');
  });

  it('approves when amount equals threshold (threshold is strictly above)', async () => {
    const { id } = await createTestKey({ label: 'approval-boundary-key' });
    db.prepare(`UPDATE api_keys SET policy_require_approval_above_usdc = ? WHERE id = ?`).run(
      '50.00',
      id,
    );

    const result = checkPolicy(id, '50.00');
    assert.equal(result.decision, 'approved');
  });
});

// ── blocked_day ───────────────────────────────────────────────────────────────

describe('checkPolicy — blocked_day rule', () => {
  before(() => resetDb());

  it('blocks when today is not in policy_allowed_days', async () => {
    const { id } = await createTestKey({ label: 'blocked-day-key' });

    // Exclude today's UTC day of week from allowed days
    const today = new Date().getUTCDay(); // 0=Sun … 6=Sat
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const allowedDays = allDays.filter((d) => d !== today);
    db.prepare(`UPDATE api_keys SET policy_allowed_days = ? WHERE id = ?`).run(
      JSON.stringify(allowedDays),
      id,
    );

    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'blocked_day');
  });

  it('approves when today is included in policy_allowed_days', async () => {
    const { id } = await createTestKey({ label: 'allowed-day-key' });

    // Include every day — always allowed
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    db.prepare(`UPDATE api_keys SET policy_allowed_days = ? WHERE id = ?`).run(
      JSON.stringify(allDays),
      id,
    );

    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'approved');
  });
});

// ── after_hours ───────────────────────────────────────────────────────────────

describe('checkPolicy — after_hours rule', () => {
  before(() => resetDb());

  it('blocks when current UTC time is outside the allowed window', async () => {
    const { id } = await createTestKey({ label: 'after-hours-key' });

    // A 1-minute window at midnight — almost certainly outside current time.
    // Verify the assumption before asserting.
    const window = { start: '00:00', end: '00:01' };
    db.prepare(`UPDATE api_keys SET policy_allowed_hours = ? WHERE id = ?`).run(
      JSON.stringify(window),
      id,
    );

    const now = new Date();
    const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inWindow = nowMins >= 0 && nowMins < 1; // startMins=0, endMins=1

    if (inWindow) {
      // We are in the one-minute window — skip rather than produce a false failure.
      // This is an extremely rare edge case (1 in 1440 minutes).
      return;
    }

    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'after_hours');
  });
});

// ── all checks passed ─────────────────────────────────────────────────────────

describe('checkPolicy — no policy restrictions', () => {
  before(() => resetDb());

  it('approves with approved/all_checks_passed when no policies are set', async () => {
    const { id } = await createTestKey({ label: 'no-policy-key' });

    const result = checkPolicy(id, '25.00');
    assert.equal(result.decision, 'approved');
    assert.equal(result.rule, 'all_checks_passed');
  });
});

// ── key_not_found ─────────────────────────────────────────────────────────────

describe('checkPolicy — key_not_found', () => {
  before(() => resetDb());

  it('blocks with key_not_found for an unknown api key id', () => {
    const result = checkPolicy('00000000-0000-0000-0000-000000000000', '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'key_not_found');
  });
});

// ── amount input validation ─────────────────────────────────────────────────
//
// Regression guard for the 2026-04-14 audit. checkPolicy used to trust its
// amount argument blindly: NaN made every numeric comparison false and the
// request was silently approved; negative amounts passed every `> cap`
// check because negatives are always less than positive caps; non-string
// inputs were coerced to NaN by parseFloat with the same outcome.
// orders.js validates before calling, so these bypasses were latent, but
// the function is also exported for direct use (tests, admin tools, future
// callers) and the contract should be fail-closed.

describe('checkPolicy — invalid_amount input validation', () => {
  before(() => resetDb());

  it('blocks a NaN amount with invalid_amount', async () => {
    const { id } = await createTestKey({ label: 'nan-amt' });
    const result = checkPolicy(id, 'not-a-number');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'invalid_amount');
  });

  it('blocks a negative amount with invalid_amount', async () => {
    const { id } = await createTestKey({ label: 'neg-amt' });
    const result = checkPolicy(id, '-50.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'invalid_amount');
  });

  it('blocks zero with invalid_amount', async () => {
    const { id } = await createTestKey({ label: 'zero-amt' });
    const result = checkPolicy(id, '0');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'invalid_amount');
  });

  it('blocks an empty string with invalid_amount', async () => {
    const { id } = await createTestKey({ label: 'empty-amt' });
    const result = checkPolicy(id, '');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'invalid_amount');
  });

  it('blocks Infinity with invalid_amount', async () => {
    const { id } = await createTestKey({ label: 'inf-amt' });
    const result = checkPolicy(id, 'Infinity');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'invalid_amount');
  });
});

// ── corrupt numeric policy columns ──────────────────────────────────────────
//
// policy_single_tx_limit_usdc, policy_daily_limit_usdc and
// policy_require_approval_above_usdc are all stored as text. If one ends
// up non-numeric (bad migration, hand-edited DB, etc.) the previous code
// did `amount > parseFloat('abc')` which is always false → rule skipped
// → request silently approved past a limit that the operator had
// configured. Every corrupt-column branch now fails closed with a
// specific policy_corrupt_* rule, matching the existing
// policy_corrupt_hours / _days handling that predates this audit.

describe('checkPolicy — corrupt numeric policy columns', () => {
  before(() => resetDb());

  it('fails closed on a corrupt policy_single_tx_limit_usdc', async () => {
    const { id } = await createTestKey({ label: 'corrupt-cap' });
    db.prepare(`UPDATE api_keys SET policy_single_tx_limit_usdc = ? WHERE id = ?`).run(
      'not-a-number',
      id,
    );
    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'policy_corrupt_single_tx');
  });

  it('fails closed on a corrupt policy_daily_limit_usdc', async () => {
    const { id } = await createTestKey({ label: 'corrupt-daily' });
    db.prepare(`UPDATE api_keys SET policy_daily_limit_usdc = ? WHERE id = ?`).run('abc', id);
    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'policy_corrupt_daily');
  });

  it('fails closed on a corrupt policy_require_approval_above_usdc', async () => {
    const { id } = await createTestKey({ label: 'corrupt-approval' });
    db.prepare(`UPDATE api_keys SET policy_require_approval_above_usdc = ? WHERE id = ?`).run(
      'not-a-number',
      id,
    );
    const result = checkPolicy(id, '10.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'policy_corrupt_approval');
  });

  it('fails closed on a negative policy_single_tx_limit_usdc', async () => {
    const { id } = await createTestKey({ label: 'neg-cap' });
    db.prepare(`UPDATE api_keys SET policy_single_tx_limit_usdc = ? WHERE id = ?`).run('-5.00', id);
    const result = checkPolicy(id, '1.00');
    assert.equal(result.decision, 'blocked');
    assert.equal(result.rule, 'policy_corrupt_single_tx');
  });
});
