// @ts-check
//
// Retry helper with linear backoff (waitN = backoffMs * attemptNumber).
//
// Adversarial audit 2026-04-15:
//
//   F1-retry: safely extract a message from whatever the wrapped fn
//     throws. Pre-fix, `err.message` was dereferenced inside the catch
//     block with no defence — a wrapped fn that did `throw null` or
//     `throw 'string'` turned into `null.message` → TypeError that
//     escaped the catch and bypassed the retry loop entirely. The
//     caller saw `TypeError: Cannot read properties of null (reading
//     'message')` and only one attempt ran. Now coerced via a safe
//     helper so the retry loop is resilient to any thrown value.
//
//   F2-retry: validate attempts at the boundary. Pre-fix, attempts=0
//     (or a negative / NaN) meant the for-loop never ran, lastErr
//     stayed undefined, and `throw lastErr` produced a phantom
//     UnhandledPromiseRejection with no message. Throw a clear
//     RangeError at the boundary instead so caller bugs surface
//     at the call site.
//
//   F3-retry: fall back to the opts.backoffMs default when
//     RETRY_BACKOFF_MS is set but malformed. Pre-fix, parseInt('abc')
//     = NaN and subsequent arithmetic produced NaN wait times that
//     showed up in the log as "retrying in NaNms" and silently
//     skipped the delay (NaN > 0 is false). A genuine ops config
//     mistake looked identical to "zero backoff for tests". Now
//     rejects non-finite / negative parsed values and reverts to
//     the caller's backoffMs with a one-shot warn.

// F3-retry: dedup the "env var is broken, falling back" warning so
// a misconfigured env doesn't spam every retry call.
let _warnedBadEnv = false;

/**
 * Safe error-message extraction for the retry log line.
 * Handles: null, undefined, strings, Errors, Errors with non-string
 * .message, and objects with a thrown-getter .message.
 * @param {unknown} err
 */
function safeErrorMessage(err) {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  if (typeof err === 'string') return err;
  try {
    if (err instanceof Error && typeof err.message === 'string') return err.message;
    return String(err);
  } catch {
    return '<unstringifiable error>';
  }
}

/**
 * Read RETRY_BACKOFF_MS from the environment, falling back to the
 * caller's backoffMs if the value is missing, malformed, or negative.
 * One-shot warn on fallback so ops sees the config mistake.
 * @param {number} backoffMs
 */
function resolveBackoff(backoffMs) {
  const raw = process.env.RETRY_BACKOFF_MS;
  if (raw === undefined) return backoffMs;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!_warnedBadEnv) {
      console.warn(
        `[retry] RETRY_BACKOFF_MS=${JSON.stringify(raw)} is not a non-negative integer — ` +
          `falling back to caller default ${backoffMs}ms. Fix the env var.`,
      );
      _warnedBadEnv = true;
    }
    return backoffMs;
  }
  return parsed;
}

/**
 * Retry a fallible async function with linear backoff.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, backoffMs?: number, label?: string }} opts
 * @returns {Promise<T>}
 */
async function withRetry(fn, { attempts = 3, backoffMs = 3000, label = '' } = {}) {
  // F2-retry: validate attempts at the boundary. Non-finite / < 1
  // values would silently run zero iterations and throw an undefined
  // rejection — a confusing bug surface far from the caller.
  if (!Number.isFinite(attempts) || attempts < 1) {
    throw new RangeError(`withRetry: attempts must be >= 1, got ${attempts}`);
  }

  // F3-retry: env-var-with-fallback, validated.
  const effectiveBackoff = resolveBackoff(backoffMs);

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const wait = effectiveBackoff * i;
        // F1-retry: safe message extraction so a `throw null` doesn't
        // crash the retry loop in its own log statement.
        console.log(
          `[retry] ${label || 'operation'} attempt ${i}/${attempts} failed: ${safeErrorMessage(err)} — retrying in ${wait}ms`,
        );
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/**
 * Test-only: reset the warn-dedup state.
 */
function _resetWarnedEnv() {
  _warnedBadEnv = false;
}

module.exports = { withRetry, _resetWarnedEnv };
