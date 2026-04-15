require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, _resetWarnedEnv } = require('../../src/lib/retry');

describe('withRetry', () => {
  it('returns result immediately when fn succeeds on first call', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { attempts: 3, backoffMs: 0 },
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries on failure and returns result on 2nd attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return 'recovered';
      },
      { attempts: 3, backoffMs: 0 },
    );

    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  it('retries on failure and returns result on 3rd attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      },
      { attempts: 3, backoffMs: 0 },
    );

    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('throws the last error after all attempts exhausted', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Error(`attempt ${calls}`);
          },
          { attempts: 3, backoffMs: 0 },
        ),
      /attempt 3/,
    );
    assert.equal(calls, 3);
  });

  it('respects the attempts limit (does not over-retry)', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Error('fail');
          },
          { attempts: 2, backoffMs: 0 },
        ),
      /fail/,
    );
    assert.equal(calls, 2);
  });

  it('defaults to 3 attempts', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Error('fail');
          },
          { backoffMs: 0 },
        ),
      /fail/,
    );
    assert.equal(calls, 3);
  });

  it('propagates the error from the last attempt, not the first', async () => {
    let calls = 0;
    let capturedErr;
    try {
      await withRetry(
        async () => {
          calls++;
          throw new Error(`error from attempt ${calls}`);
        },
        { attempts: 3, backoffMs: 0 },
      );
    } catch (e) {
      capturedErr = e;
    }
    assert.ok(capturedErr, 'expected withRetry to throw');
    assert.match(capturedErr.message, /error from attempt 3/);
  });
});

// ── F1-retry: non-Error thrown values ──────────────────────────────────────
//
// A wrapped function that does `throw null` / `throw 'string'` / `throw 42`
// used to turn into `null.message` in the catch-block log statement, which
// threw a TypeError that escaped the retry loop and bypassed the retry
// entirely. Only one attempt ran, the caller saw a cryptic "Cannot read
// properties of null" error, and the real failure signal was lost.

describe('F1-retry: non-Error thrown values do not crash the retry loop', () => {
  it('retries when fn throws null', async () => {
    let calls = 0;
    let capturedErr;
    try {
      await withRetry(
        async () => {
          calls++;
          throw null;
        },
        { attempts: 3, backoffMs: 0, label: 'null-thrower' },
      );
    } catch (e) {
      capturedErr = e;
    }
    // Critical: the retry ran ALL 3 attempts (pre-fix it ran 1).
    assert.equal(calls, 3);
    assert.equal(capturedErr, null);
  });

  it('retries when fn throws undefined', async () => {
    let calls = 0;
    let capturedErr;
    try {
      await withRetry(
        async () => {
          calls++;
          throw undefined;
        },
        { attempts: 2, backoffMs: 0 },
      );
    } catch (e) {
      capturedErr = e;
    }
    assert.equal(calls, 2);
    assert.equal(capturedErr, undefined);
  });

  it('retries when fn throws a plain string', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw 'plain string error';
          },
          { attempts: 3, backoffMs: 0 },
        ),
      (e) => e === 'plain string error',
    );
    assert.equal(calls, 3);
  });

  it('retries when fn throws an Error whose .message getter throws', async () => {
    // Belt-and-braces: even if something weird goes wrong during
    // message extraction, the retry loop keeps running.
    let calls = 0;
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls++;
          const err = new Error();
          Object.defineProperty(err, 'message', {
            get() {
              throw new Error('nested');
            },
          });
          throw err;
        },
        { attempts: 3, backoffMs: 0 },
      ),
    );
    assert.equal(calls, 3);
  });

  it('retries when fn throws an Error with non-string .message', async () => {
    let calls = 0;
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls++;
          const err = new Error();
          // @ts-expect-error — intentional
          err.message = { toString: () => 'not a string' };
          throw err;
        },
        { attempts: 2, backoffMs: 0 },
      ),
    );
    assert.equal(calls, 2);
  });

  it('retries and recovers when first call throws null, second succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw null;
        return 'recovered';
      },
      { attempts: 3, backoffMs: 0 },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });
});

// ── F2-retry: attempts validation at the boundary ──────────────────────────
//
// Pre-fix, attempts=0 / -1 / NaN silently produced zero loop iterations,
// left lastErr=undefined, and then `throw undefined` surfaced as a
// phantom UnhandledPromiseRejection. Throw a clear RangeError instead.

describe('F2-retry: attempts boundary validation', () => {
  it('throws RangeError when attempts is 0', async () => {
    await assert.rejects(
      () => withRetry(async () => 'ok', { attempts: 0 }),
      /attempts must be >= 1/,
    );
  });

  it('throws RangeError when attempts is negative', async () => {
    await assert.rejects(
      () => withRetry(async () => 'ok', { attempts: -3 }),
      /attempts must be >= 1/,
    );
  });

  it('throws RangeError when attempts is NaN', async () => {
    await assert.rejects(
      () => withRetry(async () => 'ok', { attempts: NaN }),
      /attempts must be >= 1/,
    );
  });

  it('throws RangeError when attempts is Infinity', async () => {
    await assert.rejects(
      () => withRetry(async () => 'ok', { attempts: Infinity }),
      /attempts must be >= 1/,
    );
  });

  it('accepts attempts = 1 as a no-retry single-call mode', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return 'first';
      },
      { attempts: 1, backoffMs: 0 },
    );
    assert.equal(result, 'first');
    assert.equal(calls, 1);
  });

  it('attempts = 1 with a failing fn throws the error after exactly 1 call', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls++;
            throw new Error('only try');
          },
          { attempts: 1, backoffMs: 0 },
        ),
      /only try/,
    );
    assert.equal(calls, 1);
  });
});

// ── F3-retry: malformed RETRY_BACKOFF_MS env var ───────────────────────────
//
// Pre-fix, parseInt('abc') = NaN and subsequent arithmetic produced NaN
// wait times that showed up as "retrying in NaNms" in the log while
// silently skipping the delay. An ops config mistake was indistinguishable
// from intentional zero backoff. Post-fix, non-finite / negative parsed
// values fall back to the caller's backoffMs with a one-shot warn.

describe('F3-retry: RETRY_BACKOFF_MS env validation', () => {
  let origEnv;
  let origWarn;
  let warns;

  beforeEach(() => {
    origEnv = process.env.RETRY_BACKOFF_MS;
    _resetWarnedEnv();
    warns = [];
    origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.RETRY_BACKOFF_MS;
    else process.env.RETRY_BACKOFF_MS = origEnv;
    console.warn = origWarn;
  });

  it('falls back to caller backoffMs when env is non-numeric', async () => {
    process.env.RETRY_BACKOFF_MS = 'abc';
    let calls = 0;
    // Use backoffMs: 0 as the fallback so the test runs fast. The
    // fact that no NaN appears in the log (next assertion) proves the
    // fallback took effect.
    await assert.rejects(() =>
      withRetry(
        async () => {
          calls++;
          throw new Error('fail');
        },
        { attempts: 2, backoffMs: 0, label: 'env-fallback' },
      ),
    );
    assert.equal(calls, 2);
    // One-shot warn was emitted.
    assert.ok(
      warns.some((w) => /RETRY_BACKOFF_MS.*"abc".*falling back/.test(w)),
      `expected fallback warn, got: ${JSON.stringify(warns)}`,
    );
  });

  it('falls back when env is a negative integer', async () => {
    process.env.RETRY_BACKOFF_MS = '-100';
    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('fail');
        },
        { attempts: 2, backoffMs: 0 },
      ),
    );
    assert.ok(warns.some((w) => /RETRY_BACKOFF_MS.*"-100".*falling back/.test(w)));
  });

  it('accepts env = "0" as valid (test-suite zero-backoff mode)', async () => {
    process.env.RETRY_BACKOFF_MS = '0';
    await assert.rejects(() =>
      withRetry(
        async () => {
          throw new Error('fail');
        },
        { attempts: 2, backoffMs: 5000 }, // caller default ignored
      ),
    );
    // No warn — 0 is valid.
    assert.equal(warns.length, 0);
  });

  it('accepts env = "50" as valid', async () => {
    process.env.RETRY_BACKOFF_MS = '50';
    // Just prove no warn is emitted. We don't want to actually wait
    // 50ms * attempt in a unit test, so use attempts: 1 (no delay path).
    const result = await withRetry(async () => 'ok', { attempts: 1, backoffMs: 10000 });
    assert.equal(result, 'ok');
    assert.equal(warns.length, 0);
  });

  it('warns exactly ONCE across multiple retry calls with the same bad env', async () => {
    process.env.RETRY_BACKOFF_MS = 'garbage';
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() =>
        withRetry(
          async () => {
            throw new Error('fail');
          },
          { attempts: 2, backoffMs: 0 },
        ),
      );
    }
    const badWarns = warns.filter((w) => /RETRY_BACKOFF_MS/.test(w));
    assert.equal(badWarns.length, 1, `expected single dedup'd warn, got ${badWarns.length}`);
  });
});
