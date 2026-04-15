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

// ── F1-event-bus (2026-04-15): payload.type clobber regression ─────────
//
// The previous emit() ran `{ type, at, ...payload }` which gave spread
// keys precedence over the controlled type/at. A caller passing a
// payload that happened to contain a `type` or `at` field silently
// overwrote the intended event type, breaking every subscriber that
// filters by evt.type. Post-fix the spread runs FIRST and the
// controlled fields overlay last so they always win.

describe('event-bus — F1 controlled fields win over payload spread', () => {
  let bus;
  beforeEach(() => {
    bus = freshBus();
  });

  it('payload.type does NOT override the emit type', () => {
    const seen = [];
    bus.subscribe((evt) => seen.push(evt));
    // Hostile (or accidentally-shaped) payload with its own `type`.
    bus.emit('order', {
      order_id: 'abc',
      type: 'hacked_event',
      status: 'delivered',
    });
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].type,
      'order',
      'controlled type must win even when payload has a `type` field',
    );
    assert.equal(seen[0].order_id, 'abc');
    assert.equal(seen[0].status, 'delivered');
  });

  it('payload.at does NOT override the emit timestamp', () => {
    const seen = [];
    bus.subscribe((evt) => seen.push(evt));
    bus.emit('key', {
      api_key_id: 'k1',
      action: 'created',
      at: '1970-01-01T00:00:00.000Z', // hostile old timestamp
    });
    assert.equal(seen.length, 1);
    assert.notEqual(
      seen[0].at,
      '1970-01-01T00:00:00.000Z',
      'emit must stamp a fresh `at` even if payload contains its own',
    );
    // Must be a recent ISO-8601 timestamp.
    assert.match(seen[0].at, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('both clobber attempts together: type and at both get the controlled values', () => {
    const seen = [];
    bus.subscribe((evt) => seen.push(evt));
    bus.emit('system', {
      frozen: true,
      type: 'fake',
      at: 'fake-date',
      consecutive_failures: 3,
    });
    assert.equal(seen[0].type, 'system');
    assert.notEqual(seen[0].at, 'fake-date');
    assert.equal(seen[0].frozen, true);
    assert.equal(seen[0].consecutive_failures, 3);
  });
});

// ── F2-event-bus (2026-04-15): events are frozen ─────────────────────
//
// Emitted events are a SINGLE shared object reference passed to every
// listener by EventEmitter. A mutating listener would affect every
// subsequent listener. Object.freeze protects the invariant: any
// mutation is a silent no-op in sloppy mode or a throw in strict mode
// (the listener's own try/catch in `wrapped` catches the throw).

describe('event-bus — F2 event payload is frozen', () => {
  let bus;
  beforeEach(() => {
    bus = freshBus();
  });

  it('emitted events are frozen so listeners cannot mutate them', () => {
    const captured = [];
    bus.subscribe((evt) => captured.push(evt));
    bus.emit('order', { order_id: 'x', status: 'pending' });
    assert.equal(captured.length, 1);
    assert.equal(Object.isFrozen(captured[0]), true);
  });

  it('a mutating listener cannot affect subsequent listeners', () => {
    // Listener A tries to mutate the event; listener B reads the
    // original value. The critical property: B sees B's expected
    // value, not A's attempted mutation.
    const mutatorSeen = [];
    const observerSeen = [];
    bus.subscribe((evt) => {
      mutatorSeen.push({ statusBefore: evt.status });
      try {
        /** @type {any} */ (evt).status = 'hacked';
      } catch (_) {
        /* strict mode throws — either outcome is acceptable */
      }
    });
    bus.subscribe((evt) => {
      observerSeen.push({ status: evt.status });
    });
    bus.emit('order', { order_id: 'x', status: 'pending' });

    assert.equal(mutatorSeen.length, 1);
    assert.equal(mutatorSeen[0].statusBefore, 'pending');
    // The critical assertion: the second listener sees the ORIGINAL
    // status, not the mutator's attempted overwrite.
    assert.equal(observerSeen[0].status, 'pending');
  });

  it('listener throwing from a frozen-mutation in strict mode is caught by wrapped', () => {
    // Regression guard: if a listener attempts a mutation in strict
    // mode, it throws. The wrapped() try/catch must catch it so the
    // throw does not escape to EventEmitter (which would crash the
    // emitting caller via 'error' event handling).
    const observerSeen = [];
    bus.subscribe((evt) => {
      // Use a strict-mode arrow in a wrapper to force throw-on-assign.
      'use strict';
      /** @type {any} */ (evt).status = 'hacked';
    });
    bus.subscribe((evt) => observerSeen.push(evt.status));
    assert.doesNotThrow(() => {
      bus.emit('order', { order_id: 'x', status: 'pending' });
    });
    // Second listener still ran and saw the untouched status.
    assert.equal(observerSeen[0], 'pending');
  });
});
