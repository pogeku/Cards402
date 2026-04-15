// @ts-check
// Public-facing error sanitiser.
//
// Every fulfillment failure is logged in detail server-side so operators
// can debug, but the version exposed to AGENTS via /v1/orders/:id and
// the SSE stream and the failure webhook gets boiled down to one of a
// small fixed set of public error codes + messages.
//
// When NOT to use this module:
//
//   - HTTP-layer errors (invalid_api_key, rate_limit_exceeded,
//     invalid_amount, spend_limit_exceeded on order creation). Those
//     have dedicated typed classes in sdk/src/errors.ts that the
//     client already knows how to catch by instanceof; running them
//     through sanitize() would collapse them into the GENERIC bucket
//     and lose the structure the SDK depends on.
//
//   - Ops-internal state (webhook_queue.last_error, audit log bodies,
//     bizEvent payloads). These never reach agents, so scrubbing
//     them is unnecessary and loses debugging signal.
//
// The right rule: call sanitize() only when the result is about to be
// written to `orders.error` or included in a delivery/failure webhook
// payload — anywhere else, keep the raw error for ops visibility.
//
// Tests: backend/test/unit/sanitize-error.test.js locks the contract
// (30 cases) so any change to RULES / GENERIC still guarantees no
// internal vocabulary leaks into a public message.
//
// Why: the cards402 ↔ vcc ↔ CTX ↔ scraper pipeline has a lot of
// internal moving parts (vcc, captcha solvers, playwright, stage1/stage2
// scrapers, yourrewardcard, CTX merchant ids, etc.). Leaking those names
// into agent-visible error messages does three bad things:
//
//   1. Tells third-party agents about implementation details they have
//      no business knowing or being able to use.
//   2. Trains agents to handle errors by string-matching on internal
//      vocab that we want to be free to change.
//   3. Looks unprofessional / buggy to an agent author who sees raw
//      stack-trace fragments in their dashboard.
//
// The mapping below is conservative: anything we recognise gets a
// stable code + a one-sentence message. Anything we don't recognise
// falls through to a generic 'fulfillment_unavailable' so we never
// leak bytes from a new error path the first time it fires.

/** @typedef {{ code: string, message: string, retryable: boolean }} PublicError */

// F1-sanitize (2026-04-15): Freeze every exported PublicError at module
// load so a caller mutating the returned object cannot corrupt subsequent
// sanitize() calls. Same class of fix as logger.js and event-bus.js: any
// module-level constant that's handed to callers by reference becomes a
// shared-state leak the moment someone writes `sanitize(err).message = ...`.
// Object.freeze on sloppy-mode assignment is a silent noop (on strict-mode
// it throws), so the defense is belt-and-braces rather than surgical.
// Freezing at module load means the cost is paid once per process and the
// shape is invariant for the lifetime of the runtime.

/** @type {PublicError} */
const GENERIC = Object.freeze({
  code: 'fulfillment_unavailable',
  message:
    'The order could not be fulfilled right now. Your payment has been refunded automatically. Try again in a few minutes.',
  retryable: true,
});

// Each entry: regex against the raw error string → public payload.
// Order matters — first match wins. Keep specific patterns above
// generic ones.
//
// Ordering rationale (adversarial audit F1-sanitize):
//
//   1. service_unavailable / frozen / circuit  — system-wide signals
//      that take precedence over everything, including specific
//      fulfillment errors. "VCC circuit open" is genuinely the whole
//      VCC path being down, not a per-order failure.
//
//   2. internal-vocab catchall  — runs BEFORE insufficient / policy /
//      timeout rules so that a VCC/CTX/treasury/scraper/merchant
//      error containing the word "insufficient" doesn't false-match
//      the insufficient_funds rule below and tell the AGENT to top
//      up their wallet when the problem was actually in OUR
//      treasury / the upstream merchant. Concrete example pre-fix:
//      "vcc invoice failed: treasury insufficient USDC balance" was
//      routed to insufficient_funds, misdirecting the agent.
//
//   3. insufficient_funds                  — only after the internal-
//      vocab scrub, so it only ever matches genuine agent-wallet
//      errors from the Stellar submit path.
//
//   4. policy_blocked                      — spend / approval rules.
//
//   5. upstream_timeout                    — network flakiness to
//      anything outside cards402.
//
//   6. payment_expired                     — the order's payment
//      window closed before fulfillment ran.
// Every rule's `out` is wrapped in Object.freeze at module load (F1-sanitize)
// so sanitize() can return the shared reference without worrying about
// caller-side mutation. The RULES array itself is frozen too, so a
// downstream module can't `push` a bogus rule or reorder the set in-place.
const RULES = Object.freeze([
  // Ambiguous on-chain outcome on the outbound CTX payment leg
  // (audit F1-jobs 2026-04-15). This runs FIRST — before any
  // "your payment has been refunded" rules — because the whole
  // reason we route to this code is that we deliberately did NOT
  // auto-refund. A generic "refunded automatically" message here
  // would be a lie to the agent and invite a duplicate charge
  // complaint that operators then have to debunk.
  {
    re: /ctx_payment_ambiguous/i,
    out: Object.freeze({
      code: 'payment_pending_review',
      message:
        'The payment reached an ambiguous on-chain state and is being verified by an operator. Do not retry this order. Support will update you with a resolution.',
      retryable: false,
    }),
  },
  // Whole pipeline temporarily down — frozen by ops or VCC circuit
  // breaker tripped. Runs first because these are system-wide.
  {
    re: /service_temporarily_unavailable|frozen|circuit.*open/i,
    out: Object.freeze({
      code: 'service_unavailable',
      message:
        'The fulfillment service is temporarily unavailable. Your payment has been refunded. Retry in a few minutes.',
      retryable: true,
    }),
  },
  // Anything from the upstream gift-card provider, the scraper, the
  // captcha racer, the headless browser, or our internal vcc service
  // collapses into one bucket. Runs BEFORE the insufficient / policy /
  // timeout rules so that an internal error containing those words
  // (e.g., "VCC treasury insufficient USDC") cannot false-match and
  // misdirect the agent. Agents do not need to know which step broke
  // — only that the order didn't complete and they were refunded.
  {
    re: /VCC|vcc-callback|ctx_error|CTX |gift-card|scrap|captcha|playwright|browser|libnspr|chrome|chromium|stage1|stage2|yourrewardcard|merchant|recaptcha|hCaptcha/i,
    out: Object.freeze({
      code: 'fulfillment_unavailable',
      message:
        'The order could not be fulfilled right now. Your payment has been refunded automatically. Try again in a few minutes.',
      retryable: true,
    }),
  },
  // Insufficient funds on the agent's wallet — let the agent know to top up.
  // Only reachable after the internal-vocab scrub above, so it only
  // fires on genuine Stellar-submit failures from the agent's wallet.
  {
    re: /insufficient.*balance|insufficient.*funds/i,
    out: Object.freeze({
      code: 'insufficient_funds',
      message: 'Wallet balance was too low to complete the payment. Top up and try again.',
      retryable: true,
    }),
  },
  // Spend / approval policy stops the order before fulfillment runs.
  {
    re: /spend_limit_exceeded|policy_blocked|requires_approval/i,
    out: Object.freeze({
      code: 'policy_blocked',
      message:
        'This order was blocked by your account policy (spend limit, time window, or approval rule).',
      retryable: false,
    }),
  },
  // Network / timeout against any upstream.
  {
    re: /ETIMEDOUT|ECONN|ENETUNREACH|EAI_AGAIN|fetch failed|HTTP 5\d\d/i,
    out: Object.freeze({
      code: 'upstream_timeout',
      message:
        'A network call to fulfill the order timed out. Your payment has been refunded automatically. Retry in a minute.',
      retryable: true,
    }),
  },
  // Order expired before we could pay it.
  {
    re: /expired|payment window/i,
    out: Object.freeze({
      code: 'payment_expired',
      message:
        'The payment window expired before the order could be fulfilled. No funds were taken.',
      retryable: false,
    }),
  },
]);

/**
 * Map a raw internal error string to a public-facing payload. Pure
 * function; safe to call from anywhere.
 *
 * F2-sanitize (2026-04-15): the string coercion is wrapped in try/catch.
 * sanitize() sits on the error-handling path — it's called to convert
 * failures into public webhook payloads. A second-order failure here
 * (e.g., an Error with a getter-thrown .message, a Proxy whose toString
 * rejects, a value whose Symbol.toPrimitive throws) would swallow the
 * original error completely and either take the fulfillment worker to
 * its outer catch or produce an UnhandledPromiseRejection. Instead,
 * any coercion failure falls through to the GENERIC bucket — the
 * agent sees a generic failure message and operator logs get the
 * second-order error, but the primary failure signal is preserved.
 * The rule-matching loop is inside the same try so a malformed value
 * whose typeof/String succeeded but whose RegExp.test triggers a
 * thrown coercion (custom Symbol.toPrimitive, Proxy revoke, etc.) also
 * can't crash the caller.
 *
 * @param {unknown} raw
 * @returns {PublicError}
 */
function sanitize(raw) {
  if (raw === null || raw === undefined) return GENERIC;
  let s;
  try {
    if (typeof raw === 'string') {
      s = raw;
    } else if (raw instanceof Error) {
      // raw.message is typed `string` but the language doesn't enforce
      // it — a thrown getter or a subclass with a non-string message
      // both land inside this try.
      s = String(raw.message);
    } else {
      s = String(raw);
    }
  } catch {
    return GENERIC;
  }
  try {
    for (const rule of RULES) {
      if (rule.re.test(s)) return rule.out;
    }
  } catch {
    return GENERIC;
  }
  return GENERIC;
}

/**
 * Same, but returns just the public message — useful when storing into
 * `orders.error` where we only have one column.
 * @param {unknown} raw
 */
function publicMessage(raw) {
  return sanitize(raw).message;
}

/**
 * Same, but returns just the public code.
 * @param {unknown} raw
 */
function publicCode(raw) {
  return sanitize(raw).code;
}

module.exports = { sanitize, publicMessage, publicCode };
