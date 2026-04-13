// Constants table tests — makes sure the lookup helpers fall back
// safely on unknown values so a new backend status doesn't crash
// the UI.

import { describe, it, expect } from 'vitest';
import {
  AGENT_STATE_TONE,
  AGENT_STATE_LABEL,
  AGENT_STATE_PULSING,
  ORDER_STATUS_TONE,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_PULSING,
  IN_FLIGHT_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  getOrderStatusLabel,
  getOrderStatusTone,
} from './constants';

describe('agent state lookup tables', () => {
  it('has an entry for every known state', () => {
    const states: Array<keyof typeof AGENT_STATE_LABEL> = [
      'minted',
      'initializing',
      'awaiting_funding',
      'funded',
      'active',
    ];
    for (const s of states) {
      expect(AGENT_STATE_TONE[s]).toBeDefined();
      expect(AGENT_STATE_LABEL[s]).toBeDefined();
    }
  });

  it('marks transient states as pulsing', () => {
    expect(AGENT_STATE_PULSING.has('initializing')).toBe(true);
    expect(AGENT_STATE_PULSING.has('awaiting_funding')).toBe(true);
    expect(AGENT_STATE_PULSING.has('active')).toBe(false);
  });
});

describe('order status lookup helpers', () => {
  it('maps delivered/failed/refunded to the expected tones', () => {
    expect(getOrderStatusTone('delivered')).toBe('green');
    expect(getOrderStatusTone('failed')).toBe('red');
    expect(getOrderStatusTone('refunded')).toBe('blue');
  });

  it('falls back to purple for unknown statuses', () => {
    expect(getOrderStatusTone('brand_new_status')).toBe('purple');
  });

  it('formats unknown labels with underscores-as-spaces', () => {
    expect(getOrderStatusLabel('brand_new_status')).toBe('brand new status');
  });

  it('ORDER_STATUS_LABEL covers the common path', () => {
    expect(ORDER_STATUS_LABEL['pending_payment']).toBe('Pending payment');
  });

  it('IN_FLIGHT_ORDER_STATUSES covers the fulfillment path', () => {
    expect(IN_FLIGHT_ORDER_STATUSES.has('ordering')).toBe(true);
    expect(IN_FLIGHT_ORDER_STATUSES.has('delivered')).toBe(false);
  });

  it('TERMINAL_ORDER_STATUSES matches the schema', () => {
    expect(TERMINAL_ORDER_STATUSES.has('delivered')).toBe(true);
    expect(TERMINAL_ORDER_STATUSES.has('ordering')).toBe(false);
  });

  it('ORDER_STATUS_PULSING includes in-flight statuses', () => {
    expect(ORDER_STATUS_PULSING.has('pending_payment')).toBe(true);
  });

  it('ORDER_STATUS_TONE has entries for all the labels we ship', () => {
    for (const status of Object.keys(ORDER_STATUS_LABEL)) {
      expect(ORDER_STATUS_TONE[status]).toBeDefined();
    }
  });
});
