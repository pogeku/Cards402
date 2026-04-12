import { describe, it, expect } from 'vitest';
import {
  Cards402Error,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  PriceUnavailableError,
  InvalidAmountError,
  AuthError,
  OrderFailedError,
  WaitTimeoutError,
  parseApiError,
} from '../errors';

describe('Cards402Error', () => {
  it('is an instance of Error', () => {
    const err = new Cards402Error('msg', 'code', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(Cards402Error);
  });

  it('sets message, code, status', () => {
    const err = new Cards402Error('something broke', 'test_code', 422);
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('test_code');
    expect(err.status).toBe(422);
    expect(err.name).toBe('Cards402Error');
  });

  it('stores raw payload', () => {
    const raw = { detail: 'extra' };
    const err = new Cards402Error('msg', 'code', 400, raw);
    expect(err.raw).toBe(raw);
  });
});

describe('SpendLimitError', () => {
  it('is instanceof Cards402Error and SpendLimitError', () => {
    const err = new SpendLimitError('100.00', '85.00');
    expect(err).toBeInstanceOf(Cards402Error);
    expect(err).toBeInstanceOf(SpendLimitError);
  });

  it('sets limit and spent fields', () => {
    const err = new SpendLimitError('50.00', '50.00');
    expect(err.limit).toBe('50.00');
    expect(err.spent).toBe('50.00');
    expect(err.code).toBe('spend_limit_exceeded');
    expect(err.status).toBe(403);
    expect(err.name).toBe('SpendLimitError');
  });

  it('includes amounts in message', () => {
    const err = new SpendLimitError('100.00', '99.99');
    expect(err.message).toContain('99.99');
    expect(err.message).toContain('100.00');
  });
});

describe('RateLimitError', () => {
  it('has correct code and status', () => {
    const err = new RateLimitError();
    expect(err).toBeInstanceOf(Cards402Error);
    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.status).toBe(429);
    expect(err.name).toBe('RateLimitError');
  });
});

describe('ServiceUnavailableError', () => {
  it('has correct code and status', () => {
    const err = new ServiceUnavailableError();
    expect(err.code).toBe('service_temporarily_unavailable');
    expect(err.status).toBe(503);
    expect(err.name).toBe('ServiceUnavailableError');
  });

  it('accepts custom message', () => {
    const err = new ServiceUnavailableError('custom msg');
    expect(err.message).toBe('custom msg');
  });
});

describe('PriceUnavailableError', () => {
  it('has correct code and status', () => {
    const err = new PriceUnavailableError();
    expect(err.code).toBe('price_unavailable');
    expect(err.status).toBe(503);
  });

  it('accepts custom message', () => {
    const err = new PriceUnavailableError('price is down');
    expect(err.message).toBe('price is down');
  });
});

describe('InvalidAmountError', () => {
  it('has correct code and status', () => {
    const err = new InvalidAmountError();
    expect(err.code).toBe('invalid_amount');
    expect(err.status).toBe(400);
    expect(err.name).toBe('InvalidAmountError');
  });
});

describe('AuthError', () => {
  it('has correct code and status', () => {
    const err = new AuthError();
    expect(err.code).toBe('invalid_api_key');
    expect(err.status).toBe(401);
    expect(err.name).toBe('AuthError');
  });
});

describe('OrderFailedError', () => {
  it('sets orderId and reason', () => {
    const err = new OrderFailedError('ord_123', 'supplier error');
    expect(err.orderId).toBe('ord_123');
    expect(err.code).toBe('order_failed');
    expect(err.name).toBe('OrderFailedError');
  });

  it('includes refund txid in message when provided', () => {
    const err = new OrderFailedError('ord_456', 'failed', { stellar_txid: 'abc123' });
    expect(err.refund).toEqual({ stellar_txid: 'abc123' });
    expect(err.message).toContain('abc123');
  });

  it('says refund will be processed when no refund', () => {
    const err = new OrderFailedError('ord_789', 'failed');
    expect(err.refund).toBeUndefined();
    expect(err.message).toContain('refund');
  });

  it('is instanceof Cards402Error', () => {
    expect(new OrderFailedError('x', 'y')).toBeInstanceOf(Cards402Error);
  });
});

describe('WaitTimeoutError', () => {
  it('includes orderId and timeout in message', () => {
    const err = new WaitTimeoutError('ord_abc', 300000);
    expect(err.orderId).toBe('ord_abc');
    expect(err.message).toContain('300s');
    expect(err.message).toContain('ord_abc');
    expect(err.code).toBe('wait_timeout');
    expect(err.status).toBe(408);
  });

  it('is instanceof Cards402Error', () => {
    expect(new WaitTimeoutError('x', 1000)).toBeInstanceOf(Cards402Error);
  });
});

describe('parseApiError', () => {
  it('returns SpendLimitError for spend_limit_exceeded', () => {
    const err = parseApiError(403, {
      error: 'spend_limit_exceeded',
      limit: '100.00',
      spent: '100.00',
    });
    expect(err).toBeInstanceOf(SpendLimitError);
    const sle = err as SpendLimitError;
    expect(sle.limit).toBe('100.00');
    expect(sle.spent).toBe('100.00');
  });

  it('returns RateLimitError for rate_limit_exceeded', () => {
    const err = parseApiError(429, { error: 'rate_limit_exceeded' });
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('returns ServiceUnavailableError for service_temporarily_unavailable', () => {
    const err = parseApiError(503, { error: 'service_temporarily_unavailable', message: 'frozen' });
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.message).toBe('frozen');
  });

  it('returns PriceUnavailableError for price_unavailable', () => {
    const err = parseApiError(503, { error: 'price_unavailable' });
    expect(err).toBeInstanceOf(PriceUnavailableError);
  });

  it('returns InvalidAmountError for invalid_amount', () => {
    const err = parseApiError(400, { error: 'invalid_amount' });
    expect(err).toBeInstanceOf(InvalidAmountError);
  });

  it('returns AuthError for missing_api_key', () => {
    const err = parseApiError(401, { error: 'missing_api_key' });
    expect(err).toBeInstanceOf(AuthError);
  });

  it('returns AuthError for invalid_api_key', () => {
    const err = parseApiError(401, { error: 'invalid_api_key' });
    expect(err).toBeInstanceOf(AuthError);
  });

  it('returns generic Cards402Error for unknown codes', () => {
    const err = parseApiError(500, { error: 'internal_error', message: 'oops' });
    expect(err).toBeInstanceOf(Cards402Error);
    expect(err).not.toBeInstanceOf(SpendLimitError);
    expect(err.code).toBe('internal_error');
    expect(err.message).toBe('oops');
    expect(err.status).toBe(500);
  });

  it('falls back to error field as message when message is absent', () => {
    const err = parseApiError(400, { error: 'some_code' });
    expect(err.message).toBe('some_code');
  });

  it('handles missing body fields gracefully', () => {
    const err = parseApiError(500, {});
    expect(err).toBeInstanceOf(Cards402Error);
    expect(err.code).toBe('unknown');
  });
});
