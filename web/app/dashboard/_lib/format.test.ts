// Format helpers — every function is pure so tests are trivial.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatUsd, formatAmountShort, timeAgo, truncateAddress, bucketSpendByDay } from './format';

describe('formatUsd', () => {
  it('formats numeric strings with 2 decimals by default', () => {
    expect(formatUsd('10')).toBe('$10.00');
    expect(formatUsd('10.5')).toBe('$10.50');
    expect(formatUsd('1234.5678')).toBe('$1,234.57');
  });

  it('formats numbers as well as strings', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(9.99)).toBe('$9.99');
  });

  it('respects decimal precision', () => {
    expect(formatUsd('42.123', 3)).toBe('$42.123');
    expect(formatUsd('42', 0)).toBe('$42');
  });

  it('returns $0.00 on NaN input', () => {
    expect(formatUsd('not a number')).toBe('$0.00');
  });
});

describe('formatAmountShort', () => {
  it('uses M / k suffixes for large values', () => {
    expect(formatAmountShort(2_500_000)).toBe('2.50M');
    expect(formatAmountShort(15_000)).toBe('15.0k');
  });

  it('shows two decimals below 1k', () => {
    expect(formatAmountShort(12.3)).toBe('12.30');
  });

  it('returns 0 on NaN', () => {
    expect(formatAmountShort('bogus')).toBe('0');
  });
});

describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns — for null / undefined / unparsable input', () => {
    expect(timeAgo(null)).toBe('—');
    expect(timeAgo(undefined)).toBe('—');
    expect(timeAgo('not-a-date')).toBe('—');
  });

  it('returns "just now" within 10s', () => {
    expect(timeAgo('2026-04-13T11:59:55Z')).toBe('just now');
  });

  it('returns seconds for 10–59s ago', () => {
    expect(timeAgo('2026-04-13T11:59:30Z')).toBe('30s ago');
  });

  it('returns minutes / hours / days for larger gaps', () => {
    expect(timeAgo('2026-04-13T11:55:00Z')).toBe('5m ago');
    expect(timeAgo('2026-04-13T10:00:00Z')).toBe('2h ago');
    expect(timeAgo('2026-04-10T12:00:00Z')).toBe('3d ago');
  });
});

describe('truncateAddress', () => {
  it('truncates long addresses with default left/right', () => {
    expect(truncateAddress('GABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('GABC…WXYZ');
  });

  it('keeps short strings intact', () => {
    expect(truncateAddress('ABCD')).toBe('ABCD');
  });

  it('returns — for null', () => {
    expect(truncateAddress(null)).toBe('—');
  });

  it('respects custom widths', () => {
    // 'GABCDEFGHIJKLMNOPQRSTUV' — left 6 = 'GABCDE', right 4 = 'STUV'
    expect(truncateAddress('GABCDEFGHIJKLMNOPQRSTUV', 6, 4)).toBe('GABCDE…STUV');
  });
});

describe('bucketSpendByDay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces the requested number of buckets', () => {
    const result = bucketSpendByDay([], 7);
    expect(result).toHaveLength(7);
  });

  it('only counts delivered orders in the revenue sum', () => {
    const orders = [
      { created_at: '2026-04-13T00:00:00Z', amount_usdc: '10', status: 'delivered' },
      { created_at: '2026-04-13T00:00:00Z', amount_usdc: '5', status: 'failed' },
      { created_at: '2026-04-13T00:00:00Z', amount_usdc: '20', status: 'refunded' },
    ];
    const buckets = bucketSpendByDay(orders, 1);
    expect(buckets[0]?.amount).toBe(10);
    expect(buckets[0]?.count).toBe(1);
  });

  it('ignores orders outside the window', () => {
    const orders = [
      { created_at: '2026-01-01T00:00:00Z', amount_usdc: '100', status: 'delivered' },
    ];
    const buckets = bucketSpendByDay(orders, 3);
    const totalAmount = buckets.reduce((s, b) => s + b.amount, 0);
    expect(totalAmount).toBe(0);
  });
});
