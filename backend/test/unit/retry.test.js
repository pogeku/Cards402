require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../../src/lib/retry');

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
