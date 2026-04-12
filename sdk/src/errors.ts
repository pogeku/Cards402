/**
 * Structured error types for the cards402 SDK.
 *
 * Catch by type so your agent can handle each case without string-parsing:
 *
 *   try {
 *     const card = await client.createOrder({ amount_usdc: '10.00' });
 *   } catch (err) {
 *     if (err instanceof SpendLimitError) { ... }
 *     if (err instanceof ServiceUnavailableError) { ... }
 *   }
 */

/** Base class — all cards402 errors extend this. */
export class Cards402Error extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'Cards402Error';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The API key's spend limit has been reached. */
export class SpendLimitError extends Cards402Error {
  constructor(public readonly limit: string, public readonly spent: string) {
    super(
      `Spend limit exceeded: $${spent} spent of $${limit} limit. Ask your operator to raise the limit or wait for the next reset period.`,
      'spend_limit_exceeded',
      403,
    );
    this.name = 'SpendLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Too many orders created in the current window (60/hour). */
export class RateLimitError extends Cards402Error {
  constructor() {
    super(
      'Rate limit exceeded — maximum 60 orders per hour per API key. Wait before retrying.',
      'rate_limit_exceeded',
      429,
    );
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Service is temporarily suspended (fulfillment circuit breaker tripped). */
export class ServiceUnavailableError extends Cards402Error {
  constructor(message = 'Card fulfillment is temporarily suspended. Retry in a few minutes.') {
    super(message, 'service_temporarily_unavailable', 503);
    this.name = 'ServiceUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** XLM price feed is unavailable — retry or use USDC. */
export class PriceUnavailableError extends Cards402Error {
  constructor(message = 'XLM price is temporarily unavailable. Retry shortly, or use payment_asset: "usdc".') {
    super(message, 'price_unavailable', 503);
    this.name = 'PriceUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** amount_usdc was missing, zero, or non-numeric. */
export class InvalidAmountError extends Cards402Error {
  constructor(message = 'Invalid amount_usdc — must be a positive number string, e.g. "10.00".') {
    super(message, 'invalid_amount', 400);
    this.name = 'InvalidAmountError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The API key is missing or invalid. */
export class AuthError extends Cards402Error {
  constructor() {
    super(
      'Invalid or missing API key. Pass it as the X-Api-Key header, or set CARDS402_API_KEY.',
      'invalid_api_key',
      401,
    );
    this.name = 'AuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Order failed during fulfillment. A refund may be in progress. */
export class OrderFailedError extends Cards402Error {
  constructor(
    public readonly orderId: string,
    reason: string,
    public readonly refund?: { stellar_txid: string },
  ) {
    const refundNote = refund
      ? ` Your payment is being refunded (txid: ${refund.stellar_txid}).`
      : ' A refund will be processed if payment was received.';
    super(`Order ${orderId} failed: ${reason}.${refundNote}`, 'order_failed', 200, { orderId, reason, refund });
    this.name = 'OrderFailedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Waiting for a card timed out — order may still be processing. */
export class WaitTimeoutError extends Cards402Error {
  constructor(public readonly orderId: string, timeoutMs: number) {
    super(
      `Timed out waiting for card after ${timeoutMs / 1000}s (order: ${orderId}). ` +
        'Poll GET /v1/orders/:id to check status — it may still complete.',
      'wait_timeout',
      408,
    );
    this.name = 'WaitTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parse a raw API error response into the appropriate typed error.
 * Falls back to generic Cards402Error for unknown codes.
 */
export function parseApiError(status: number, body: Record<string, unknown>): Cards402Error {
  const code = String(body.error ?? 'unknown');
  const message = String(body.message ?? body.error ?? 'Unknown error');

  switch (code) {
    case 'spend_limit_exceeded':
      return new SpendLimitError(String(body.limit ?? '?'), String(body.spent ?? '?'));
    case 'rate_limit_exceeded':
      return new RateLimitError();
    case 'service_temporarily_unavailable':
      return new ServiceUnavailableError(message);
    case 'price_unavailable':
    case 'xlm_price_unavailable':
      return new PriceUnavailableError(message);
    case 'invalid_amount':
      return new InvalidAmountError(message);
    case 'missing_api_key':
    case 'invalid_api_key':
      return new AuthError();
    default:
      return new Cards402Error(message, code, status, body);
  }
}
