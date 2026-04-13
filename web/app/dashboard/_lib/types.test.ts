// Type-guard tests for alert kind categorisation. Exists so an
// adversarial audit can grep for "isSystemAlertKind" and find a
// regression suite asserting the system kinds stay locked down.

import { describe, it, expect } from 'vitest';
import { isSystemAlertKind, SYSTEM_ALERT_KINDS } from './types';

describe('isSystemAlertKind', () => {
  it('returns true for ctx_auth_dead', () => {
    expect(isSystemAlertKind('ctx_auth_dead')).toBe(true);
  });

  it('returns true for circuit_breaker_frozen', () => {
    expect(isSystemAlertKind('circuit_breaker_frozen')).toBe(true);
  });

  it('returns false for user kinds', () => {
    expect(isSystemAlertKind('failure_rate_high')).toBe(false);
    expect(isSystemAlertKind('spend_over')).toBe(false);
    expect(isSystemAlertKind('agent_balance_low')).toBe(false);
  });

  it('returns false for unknown / empty input', () => {
    expect(isSystemAlertKind('')).toBe(false);
    expect(isSystemAlertKind('not_a_real_kind')).toBe(false);
  });

  it('SYSTEM_ALERT_KINDS contains exactly the system kinds', () => {
    expect(SYSTEM_ALERT_KINDS.size).toBe(2);
    expect(SYSTEM_ALERT_KINDS.has('ctx_auth_dead')).toBe(true);
    expect(SYSTEM_ALERT_KINDS.has('circuit_breaker_frozen')).toBe(true);
  });
});
