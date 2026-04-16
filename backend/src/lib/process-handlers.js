// @ts-check
// Helpers for Node process-level handlers (uncaughtException,
// unhandledRejection). Extracted from src/index.js so the formatter
// logic can be unit-tested without loading index.js — which runs the
// production side effects (startJobs, startWatcher, app.listen,
// signal registration) at module load.
//
// Adversarial audit F2-index (2026-04-16): the unhandledRejection
// handler used to emit only `console.error('... at', promise,
// 'reason:', reason)`. That stringified the Promise as
// `[object Promise]` making the log nearly useless, and there was
// no structured bizEvent so the ops alerting pipeline had no push
// signal for a class of error that is usually indicative of a real
// programming bug. The formatter below produces a structured payload
// for both bizEvent emission and a readable stderr line.

/**
 * @typedef {{
 *   type: string,
 *   name: string,
 *   message: string,
 *   stack: string | null,
 * }} RejectionPayload
 */

/**
 * Format an arbitrary thrown-or-rejected value into a structured
 * payload suitable for both bizEvent and console output. Handles
 * every pathological case the retry.js / sanitize-error.js audits
 * taught us to expect: null, undefined, strings, non-Error objects,
 * Errors with a getter-thrown `.message`, Proxies, and values whose
 * `toString` throws.
 *
 * @param {unknown} reason
 * @returns {RejectionPayload}
 */
function formatRejection(reason) {
  // `instanceof` invokes the target's [Symbol.hasInstance], which
  // on a revoked Proxy throws a TypeError from getPrototypeOf. Wrap
  // the check so a hostile or pathological reason can't crash the
  // handler before we can even format it.
  let isError = false;
  try {
    isError = reason instanceof Error;
  } catch {
    isError = false;
  }
  if (isError) {
    // TS can't narrow `reason` from `unknown` to `Error` because the
    // instanceof is wrapped in a try/catch above. The cast is safe —
    // isError is only true when instanceof succeeded.
    const err = /** @type {Error} */ (reason);
    let message;
    try {
      message = typeof err.message === 'string' ? err.message.slice(0, 512) : '';
    } catch {
      message = '<unstringifiable message>';
    }
    let stack = null;
    try {
      if (typeof err.stack === 'string') stack = err.stack.slice(0, 2048);
    } catch {
      /* ignored — stack getter may throw on exotic subclasses */
    }
    return {
      type: 'error',
      name: err.name || 'Error',
      message,
      stack,
    };
  }
  if (reason === null) {
    return { type: 'null', name: 'null', message: 'null', stack: null };
  }
  if (reason === undefined) {
    return { type: 'undefined', name: 'undefined', message: 'undefined', stack: null };
  }
  if (typeof reason === 'string') {
    return { type: 'string', name: 'string', message: reason.slice(0, 512), stack: null };
  }
  // Objects, numbers, etc. — coerce with a try/catch in case toString
  // throws (Proxy with trap, circular JSON, etc.).
  let message;
  try {
    message = String(reason).slice(0, 512);
  } catch {
    message = '<unstringifiable reason>';
  }
  let name;
  try {
    name = String(/** @type {any} */ (reason)?.constructor?.name || typeof reason);
  } catch {
    name = typeof reason;
  }
  return { type: typeof reason, name, message, stack: null };
}

module.exports = { formatRejection };
