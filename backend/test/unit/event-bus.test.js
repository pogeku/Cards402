// Unit tests for backend/src/lib/event-bus — in-process SSE fan-out.
//
// This module is the realtime backbone of every dashboard client
// (/dashboard/stream, /v1/orders/:id/stream, ...). Previously it had
// zero direct test coverage. These tests lock in the current contract:
//
//   - emit reaches every subscriber
//   - disposer removes exactly that subscriber
//   - synchronous handler throws are caught and swallowed
//   - async handler rejections are caught and do NOT escape as
//     unhandled promise rejections (F1-event-bus regression)
//   - listenerCount() reports live subscriber count (F2-event-bus)
//
// We re-require the module in every test so the module-level
// EventEmitter is fresh and listener counts don't leak across cases.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BUS_PATH = require.resolve('../../src/lib/event-bus');

function freshBus() {
  delete require.cache[BUS_PATH];
  return require('../../src/lib/event-bus');
}

describe('event-bus — basics', () => {
  let bus;

  beforeEach(() => {
    bus = freshBus();
  });

  it('emit reaches every subscribed handler', () => {
    const seen = [];
    bus.subscribe((evt) => seen.push(evt));
    bus.subscribe((evt) => seen.push({ mirror: evt }));
    bus.emit('agent_state', { api_key_id: 'k1', state: 'active' });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].type, 'agent_state');
    assert.equal(seen[0].api_key_id, 'k1');
    assert.equal(seen[0].state, 'active');
    assert.ok(seen[0].at, 'emit should stamp at');
    assert.equal(seen[1].mirror.api_key_id, 'k1');
  });

  it('disposer removes the specific subscriber', () => {
    const seenA = [];
    const seenB = [];
    const disposeA = bus.subscribe((evt) => seenA.push(evt));
    bus.subscribe((evt) => seenB.push(evt));
    bus.emit('order', { order_id: '1' });
    disposeA();
    bus.emit('order', { order_id: '2' });
    assert.equal(seenA.length, 1, 'A should only see the first event');
    assert.equal(seenB.length, 2, 'B should see both events');
  });

  it('disposer called twice is a no-op', () => {
    const dispose = bus.subscribe(() => {});
    dispose();
    // Should not throw
    dispose();
    assert.equal(bus.listenerCount(), 0);
  });
});

describe('event-bus — error handling', () => {
  let bus;

  beforeEach(() => {
    bus = freshBus();
  });

  it('catches a synchronous throw in one handler without skipping others', () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    const seen = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((evt) => seen.push(evt));
    try {
      bus.emit('order', { order_id: '42' });
    } finally {
      console.error = origError;
    }
    assert.equal(seen.length, 1, 'second subscriber should still run');
    assert.ok(errors.some((e) => /handler threw/.test(e)));
  });

  it('catches an async rejection instead of escaping as unhandled', async () => {
    // F1-event-bus regression: previously, if a subscriber was an async
    // function that rejected, the error would escape the inline try/catch
    // because the handler returned before the rejection fired. The fix
    // attaches a .then(undefined, errorHandler) to any thenable return
    // value. This test proves the rejection is caught and logged rather
    // than becoming an unhandled rejection.
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    bus.subscribe(async () => {
      throw new Error('async boom');
    });
    bus.emit('key', { api_key_id: 'x' });
    // Let the rejection microtask flush.
    await new Promise((r) => setImmediate(r));
    console.error = origError;
    assert.ok(
      errors.some((e) => /async handler rejected/.test(e)),
      `expected async-rejection log, got ${JSON.stringify(errors)}`,
    );
  });
});

describe('event-bus — listenerCount (F2)', () => {
  let bus;

  beforeEach(() => {
    bus = freshBus();
  });

  it('reports 0 when no subscribers', () => {
    assert.equal(bus.listenerCount(), 0);
  });

  it('increments and decrements with subscribe/dispose', () => {
    const d1 = bus.subscribe(() => {});
    assert.equal(bus.listenerCount(), 1);
    const d2 = bus.subscribe(() => {});
    assert.equal(bus.listenerCount(), 2);
    d1();
    assert.equal(bus.listenerCount(), 1);
    d2();
    assert.equal(bus.listenerCount(), 0);
  });
});
