// @ts-check
/**
 * Retry a fallible async function with exponential backoff.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, backoffMs?: number, label?: string }} opts
 * @returns {Promise<T>}
 */
async function withRetry(fn, { attempts = 3, backoffMs = 3000, label = '' } = {}) {
  // Allow tests to zero out retry delays without mocking the module
  const effectiveBackoff = process.env.RETRY_BACKOFF_MS !== undefined
    ? parseInt(process.env.RETRY_BACKOFF_MS, 10)
    : backoffMs;

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const wait = effectiveBackoff * i;
        console.log(`[retry] ${label || 'operation'} attempt ${i}/${attempts} failed: ${err.message} — retrying in ${wait}ms`);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
