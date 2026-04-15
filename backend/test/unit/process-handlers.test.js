// Unit tests for src/lib/process-handlers.js.
//
// F2-index (2026-04-16): structured payload builder for Node's
// uncaughtException / unhandledRejection handlers. Previously the
// handler in src/index.js did only `console.error('... at', promise,
// 'reason:', reason)`, which stringified the Promise arg as
// `[object Promise]` and left the log line nearly useless. The
// formatter produces a typed payload for bizEvent emission (so ops
// alerting pipelines get a push signal) and a readable fallback
// string for stderr.
//
// These tests pin every branch of the type coercion ladder, including
// the pathological cases the retry.js / sanitize-error.js audits
// taught us to expect.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { formatRejection } = require('../../src/lib/process-handlers');

// ── Standard Error instances ───────────────────────────────────────────────

describe('formatRejection — standard Error', () => {
  it('extracts name, message, and stack from a plain Error', () => {
    const err = new Error('boom');
    const p = formatRejection(err);
    assert.equal(p.type, 'error');
    assert.equal(p.name, 'Error');
    assert.equal(p.message, 'boom');
    assert.ok(typeof p.stack === 'string' && p.stack.length > 0);
  });

  it('preserves the subclass name (TypeError)', () => {
    const err = new TypeError('bad type');
    const p = formatRejection(err);
    assert.equal(p.name, 'TypeError');
    assert.equal(p.message, 'bad type');
  });

  it('preserves a custom Error class name', () => {
    class CardCaptureError extends Error {
      constructor(msg) {
        super(msg);
        this.name = 'CardCaptureError';
      }
    }
    const p = formatRejection(new CardCaptureError('stage2 failed'));
    assert.equal(p.name, 'CardCaptureError');
    assert.equal(p.message, 'stage2 failed');
  });

  it('truncates very long messages at 512 chars', () => {
    const err = new Error('x'.repeat(1000));
    const p = formatRejection(err);
    assert.equal(p.message.length, 512);
  });

  it('truncates very long stacks at 2048 chars', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n' + 'at ?\n'.repeat(1000);
    const p = formatRejection(err);
    assert.ok(p.stack.length <= 2048);
  });

  it('handles an Error with a non-string message gracefully', () => {
    const err = new Error();
    /** @type {any} */ (err).message = { toString: () => 'coerced' };
    const p = formatRejection(err);
    assert.equal(p.type, 'error');
    // Non-string message is captured as empty, not crash.
    assert.ok(typeof p.message === 'string');
  });

  it('handles an Error whose message getter throws', () => {
    const err = new Error();
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('getter explosion');
      },
    });
    const p = formatRejection(err);
    assert.equal(p.type, 'error');
    // Must not throw and must return some sensible message string.
    assert.ok(typeof p.message === 'string');
  });

  it('handles an Error whose stack getter throws', () => {
    const err = new Error('boom');
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error('stack explosion');
      },
    });
    const p = formatRejection(err);
    // stack is null because the getter threw, but the rest is intact.
    assert.equal(p.stack, null);
    assert.equal(p.message, 'boom');
  });

  it('defaults name to "Error" when Error.name is somehow empty', () => {
    const err = new Error('boom');
    err.name = '';
    const p = formatRejection(err);
    assert.equal(p.name, 'Error');
  });
});

// ── Primitive-typed reasons ────────────────────────────────────────────────

describe('formatRejection — primitive reasons', () => {
  it('handles null reason', () => {
    const p = formatRejection(null);
    assert.equal(p.type, 'null');
    assert.equal(p.name, 'null');
    assert.equal(p.message, 'null');
    assert.equal(p.stack, null);
  });

  it('handles undefined reason', () => {
    const p = formatRejection(undefined);
    assert.equal(p.type, 'undefined');
    assert.equal(p.name, 'undefined');
    assert.equal(p.message, 'undefined');
    assert.equal(p.stack, null);
  });

  it('handles a plain string reason', () => {
    const p = formatRejection('just a string');
    assert.equal(p.type, 'string');
    assert.equal(p.name, 'string');
    assert.equal(p.message, 'just a string');
  });

  it('truncates long string reasons at 512 chars', () => {
    const p = formatRejection('x'.repeat(1000));
    assert.equal(p.message.length, 512);
  });

  it('handles a number reason', () => {
    const p = formatRejection(42);
    assert.equal(p.type, 'number');
    assert.equal(p.message, '42');
  });

  it('handles a boolean reason', () => {
    const p = formatRejection(false);
    assert.equal(p.type, 'boolean');
    assert.equal(p.message, 'false');
  });
});

// ── Object reasons ──────────────────────────────────────────────────────────

describe('formatRejection — non-Error objects', () => {
  it('handles a plain object', () => {
    const p = formatRejection({ foo: 'bar' });
    assert.equal(p.type, 'object');
    assert.equal(p.name, 'Object');
    // String({foo:'bar'}) = '[object Object]'
    assert.match(p.message, /\[object Object\]/);
  });

  it('handles a named custom class instance', () => {
    class Foo {}
    const p = formatRejection(new Foo());
    assert.equal(p.name, 'Foo');
  });

  it('handles a value whose toString throws', () => {
    const weird = /** @type {any} */ ({
      toString() {
        throw new Error('nope');
      },
    });
    const p = formatRejection(weird);
    assert.equal(p.message, '<unstringifiable reason>');
  });

  it('handles a Proxy with a revoked target', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    // Must not throw. Any property access on a revoked Proxy throws,
    // so the formatter's try/catch around String(...) is what keeps
    // this from crashing the handler.
    const p = formatRejection(proxy);
    assert.ok(typeof p.type === 'string');
    assert.ok(typeof p.message === 'string');
  });
});

// ── Output shape contract ──────────────────────────────────────────────────

describe('formatRejection — output shape', () => {
  it('always returns an object with type/name/message/stack', () => {
    const cases = [new Error('a'), null, undefined, 'str', 42, { foo: 'bar' }, Symbol('s')];
    for (const c of cases) {
      const p = formatRejection(c);
      assert.equal(typeof p, 'object');
      assert.equal(typeof p.type, 'string');
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.message, 'string');
      assert.ok(p.stack === null || typeof p.stack === 'string');
    }
  });

  it('never throws regardless of input', () => {
    // Exotic inputs that have bitten previous audits.
    assert.doesNotThrow(() => formatRejection(null));
    assert.doesNotThrow(() => formatRejection(undefined));
    assert.doesNotThrow(() => formatRejection(Symbol('s')));
    assert.doesNotThrow(() => formatRejection(BigInt(1)));
    assert.doesNotThrow(() =>
      formatRejection({
        get foo() {
          throw new Error('nope');
        },
      }),
    );
  });
});
