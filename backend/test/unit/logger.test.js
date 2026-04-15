// Unit tests for lib/logger.js — structural log() + event() helpers
// used by literally every bizEvent site in the backend. Previously
// had zero direct coverage.
//
// Tests cover:
//   - F1: structural fields win over caller-supplied fields
//   - F2: BigInt / circular refs / Error.cause don't throw
//   - F3: closed stdout / stderr stream doesn't throw
//   - F4: baseline round-trip semantics

require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const LOGGER_PATH = require.resolve('../../src/lib/logger');

function freshLogger(nodeEnv) {
  delete require.cache[LOGGER_PATH];
  // logger reads NODE_ENV at module-load time, so we mutate before
  // re-requiring to switch between production / test / dev behavior.
  const prev = process.env.NODE_ENV;
  if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
  try {
    return { logger: require('../../src/lib/logger'), prevNodeEnv: prev };
  } finally {
    // Note: we don't restore NODE_ENV here — caller does via tryFinally.
  }
}

// Capture stdout/stderr writes for assertion. Each test stubs
// process.stdout.write / process.stderr.write, runs the logger,
// then restores them.
function captureStreams(fn) {
  const stdoutLines = [];
  const stderrLines = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    stdoutLines.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdoutLines, stderrLines };
}

describe('logger.log — production mode', () => {
  let prevNodeEnv;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete require.cache[LOGGER_PATH];
  });

  it('writes a JSON line with structural fields to stdout', () => {
    process.env.NODE_ENV = 'production';
    delete require.cache[LOGGER_PATH];
    const { log } = require('../../src/lib/logger');

    const { stdoutLines } = captureStreams(() => {
      log('info', 'hello world', { key: 'value' });
    });

    assert.equal(stdoutLines.length, 1);
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.msg, 'hello world');
    assert.equal(parsed.key, 'value');
    assert.ok(parsed.ts, 'ts must be set');
  });

  it('routes error-level logs to stderr', () => {
    process.env.NODE_ENV = 'production';
    delete require.cache[LOGGER_PATH];
    const { log } = require('../../src/lib/logger');

    const { stdoutLines, stderrLines } = captureStreams(() => {
      log('error', 'something bad', {});
    });

    assert.equal(stdoutLines.length, 0);
    assert.equal(stderrLines.length, 1);
  });
});

describe('logger — F1 structural fields win over spread', () => {
  let prevNodeEnv;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete require.cache[LOGGER_PATH];
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete require.cache[LOGGER_PATH];
  });

  it('log() caller cannot overwrite structural msg', () => {
    const { log } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      log('info', 'real message', { msg: 'spoofed message' });
    });
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.msg, 'real message');
  });

  it('log() caller cannot overwrite structural level', () => {
    const { log } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      log('info', 'hi', { level: 'error' });
    });
    // Still routed to stdout (not stderr) because the routing uses the
    // parameter, and the output level field reflects the parameter too.
    assert.equal(stdoutLines.length, 1);
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.level, 'info');
  });

  it('log() caller cannot overwrite structural ts', () => {
    const { log } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      log('info', 'hi', { ts: '1970-01-01T00:00:00.000Z' });
    });
    const parsed = JSON.parse(stdoutLines[0]);
    assert.notEqual(parsed.ts, '1970-01-01T00:00:00.000Z');
  });

  it('event() caller cannot overwrite structural event name', () => {
    const { event } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      event('real.event', { event: 'spoofed.event' });
    });
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.event, 'real.event');
  });

  it('event() caller cannot overwrite structural type', () => {
    const { event } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      event('foo', { type: 'not-event' });
    });
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.type, 'event');
  });
});

describe('logger — F2 safe JSON serialisation', () => {
  let prevNodeEnv;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete require.cache[LOGGER_PATH];
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete require.cache[LOGGER_PATH];
  });

  it('handles BigInt fields without throwing (stellar watcher i128)', () => {
    const { event } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      // Pre-fix: JSON.stringify throws "Do not know how to serialize
      // a BigInt". Post-fix: BigInt coerces to string via replacer.
      event('stellar.amount', { amount_stroops: 1234567890n });
    });
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(parsed.amount_stroops, '1234567890');
    assert.equal(parsed.event, 'stellar.amount');
  });

  it('handles a circular reference without throwing', () => {
    const { event } = require('../../src/lib/logger');
    /** @type {any} */
    const circular = { a: 1 };
    circular.self = circular;

    const { stdoutLines } = captureStreams(() => {
      // Pre-fix: JSON.stringify throws "Converting circular structure
      // to JSON". Post-fix: safeStringify catches and emits a fallback
      // line carrying the structural columns + a _stringify_error marker.
      event('order.fulfilled', { payload: circular });
    });

    assert.equal(stdoutLines.length, 1);
    const parsed = JSON.parse(stdoutLines[0]);
    // Structural fields survive the fallback.
    assert.equal(parsed.event, 'order.fulfilled');
    assert.equal(parsed.type, 'event');
    assert.ok(parsed.ts);
    // Marker field names the failure.
    assert.ok(parsed._stringify_error);
    assert.match(parsed._stringify_error, /[Cc]ircular/);
  });

  it('log() with BigInt field does not throw', () => {
    const { log } = require('../../src/lib/logger');
    const { stdoutLines } = captureStreams(() => {
      log('info', 'big number', { n: 9999999999999999999n });
    });
    assert.equal(stdoutLines.length, 1);
    const parsed = JSON.parse(stdoutLines[0]);
    assert.equal(typeof parsed.n, 'string');
  });
});

describe('logger — F3 closed-stream write safety', () => {
  let prevNodeEnv;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete require.cache[LOGGER_PATH];
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    delete require.cache[LOGGER_PATH];
  });

  it('log() does not propagate an EPIPE from stdout.write', () => {
    const { log } = require('../../src/lib/logger');
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    process.stderr.write = () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    };
    try {
      // Must NOT throw.
      log('info', 'hello', {});
      log('error', 'boom', {});
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it('event() does not propagate EPIPE from stdout.write', () => {
    const { event } = require('../../src/lib/logger');
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => {
      throw Object.assign(new Error('write EBADF'), { code: 'EBADF' });
    };
    try {
      event('whatever', { x: 1 });
    } finally {
      process.stdout.write = origOut;
    }
  });
});

// ── F4-logger (2026-04-15): bizEvent snapshot contract ────────────────
//
// event() forwards caller-supplied `fields` to the in-process event
// bus for SSE fan-out. The last event-bus audit cycle added
// Object.freeze on the TOP-level event but that freeze is shallow —
// the inner `fields` object was still shared by reference across
// every subscriber AND with the caller. Two mutation windows:
//
//   1. Caller aliasing — the caller mutates their own `fields` object
//      after event() returns (object-reuse pattern), and subscribers
//      that haven't yet run see the mutation.
//   2. Subscriber pollution — subscriber A mutates `evt.fields.x`,
//      subscriber B later in the same synchronous emit cycle sees
//      the mutation.
//
// The fix clones with structuredClone + deepFreezes the result before
// passing to bus.emit. Subscribers see a genuinely read-only snapshot
// that's decoupled from caller-side mutation and from sibling
// pollution. These tests pin both invariants.

describe('logger — F4 bizEvent snapshot contract', () => {
  const BUS_PATH = require.resolve('../../src/lib/event-bus');

  function freshLoggerBusPair() {
    // Reset BOTH so the logger grabs a fresh event-bus handle.
    // Logger lazy-requires event-bus at call time, so we clear both.
    delete require.cache[LOGGER_PATH];
    delete require.cache[BUS_PATH];
    const logger = require('../../src/lib/logger');
    const bus = require('../../src/lib/event-bus');
    return { logger, bus };
  }

  it('caller mutation AFTER event() does not affect subscribers', () => {
    const { logger, bus } = freshLoggerBusPair();
    const captured = [];
    bus.subscribe((evt) => {
      if (evt.type === 'biz') captured.push(evt.fields);
    });

    const callerFields = {
      name: 'order.fulfilled',
      fields: { order_id: 'abc', amount: '10.00' },
    };
    logger.event('order.fulfilled', callerFields.fields);

    // Caller mutates their own object AFTER the event() call.
    // Pre-fix, the subscriber's `fields` reference pointed at the
    // SAME object so this mutation leaked into the captured snapshot.
    callerFields.fields.order_id = 'HACKED';
    callerFields.fields.amount = '9999.99';

    assert.equal(captured.length, 1);
    assert.equal(captured[0].order_id, 'abc', 'caller mutation must not leak into subscriber');
    assert.equal(captured[0].amount, '10.00');
  });

  it('subscriber mutation does not pollute sibling subscribers', () => {
    const { logger, bus } = freshLoggerBusPair();

    const mutatorSeen = [];
    const observerSeen = [];

    bus.subscribe((evt) => {
      if (evt.type !== 'biz') return;
      mutatorSeen.push({ before: evt.fields.status });
      try {
        /** @type {any} */ (evt.fields).status = 'hacked';
      } catch (_) {
        /* deepFreeze makes this throw in strict mode — either
           outcome is acceptable as long as observerSeen stays clean */
      }
    });
    bus.subscribe((evt) => {
      if (evt.type !== 'biz') return;
      observerSeen.push({ status: evt.fields.status });
    });

    logger.event('order.state', { order_id: 'x', status: 'pending' });

    assert.equal(mutatorSeen.length, 1);
    assert.equal(mutatorSeen[0].before, 'pending');
    // Critical property: observer sees the ORIGINAL value, not the
    // mutator's overwrite.
    assert.equal(observerSeen[0].status, 'pending');
  });

  it('deep-nested subscriber mutation is also blocked', () => {
    const { logger, bus } = freshLoggerBusPair();

    const observerSeen = [];
    bus.subscribe((evt) => {
      if (evt.type !== 'biz') return;
      try {
        /** @type {any} */ (evt.fields.meta).inner = 'hacked';
        /** @type {any} */ (evt.fields.meta.tags)[0] = 'hacked';
      } catch (_) {
        /* deepFreeze throws — acceptable */
      }
    });
    bus.subscribe((evt) => {
      if (evt.type !== 'biz') return;
      observerSeen.push({
        inner: evt.fields.meta.inner,
        firstTag: evt.fields.meta.tags[0],
      });
    });

    logger.event('order.state', {
      order_id: 'x',
      meta: { inner: 'original', tags: ['alpha', 'beta'] },
    });

    assert.equal(observerSeen.length, 1);
    assert.equal(observerSeen[0].inner, 'original', 'nested object must be frozen');
    assert.equal(observerSeen[0].firstTag, 'alpha', 'nested array must be frozen');
  });

  it('happy path: bizEvent with simple fields reaches subscribers with full data', () => {
    // Regression guard: the clone + freeze must preserve ALL the
    // caller's data, not just the top-level keys.
    const { logger, bus } = freshLoggerBusPair();
    const captured = [];
    bus.subscribe((evt) => {
      if (evt.type === 'biz') captured.push(evt);
    });

    logger.event('payment.received', {
      asset: 'usdc',
      amount: '10.50',
      order_id: 'order-123',
      txid: 'hash-abc',
      nested: { deep: { value: 42 } },
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'biz');
    assert.equal(captured[0].name, 'payment.received');
    assert.equal(captured[0].fields.asset, 'usdc');
    assert.equal(captured[0].fields.amount, '10.50');
    assert.equal(captured[0].fields.nested.deep.value, 42);
  });

  it('uncloneable fields (function values) drop bus emit but do not throw', () => {
    // structuredClone throws DataCloneError on functions. The outer
    // try/catch in event() must swallow the throw so the caller is
    // unaffected. stdout still receives the serialized line (via the
    // non-test branch) — we can't easily assert that from test mode,
    // but we can assert the call itself doesn't throw.
    const { logger } = freshLoggerBusPair();
    assert.doesNotThrow(() => {
      logger.event('order.fulfilled', {
        order_id: 'x',
        handler: () => 'this-is-a-function',
      });
    });
  });
});
