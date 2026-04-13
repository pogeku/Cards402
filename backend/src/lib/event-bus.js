// @ts-check
// In-process event bus for real-time dashboard updates.
//
// Every state change that should appear live in the admin or per-user
// dashboard emits exactly one event here. SSE endpoints (/admin/stream,
// /dashboard/stream) subscribe and forward matching events to connected
// clients.
//
// Events are NOT persisted — subscribers see only events that happen
// while they're connected. On reconnect, the client refetches the full
// state from the REST endpoints and then starts listening again. This
// keeps the bus cheap (no outbox, no replay) while giving instant
// updates for the 99% case.
//
// Event shapes (all carry `type` + payload):
//
//   { type: 'agent_state', api_key_id, state, wallet_public_key, detail, at }
//     - fired when an agent reports via POST /v1/agent/status or when the
//       backend derives a new state (e.g. first delivered order → 'active')
//
//   { type: 'order', order_id, api_key_id, status, phase, updated_at }
//     - fired on every orders row update
//
//   { type: 'approval', approval_id, api_key_id, order_id, status, updated_at }
//     - fired when an approval is requested, approved, rejected, or expires
//
//   { type: 'key', api_key_id, action, at }
//     - fired on key lifecycle events: created, suspended, unsuspended,
//       rotated, deleted
//
//   { type: 'system', frozen, consecutive_failures, at }
//     - fired when the system-state row changes
//
// Consumers that only care about a subset filter on `type`.

const { EventEmitter } = require('events');

const bus = new EventEmitter();
// No hard cap — SSE clients come and go, and accidental over-subscription
// should be caught by the max-listeners warning not a silent drop.
bus.setMaxListeners(1000);

/**
 * Emit a dashboard event. Swallows listener errors so a misbehaving SSE
 * client can't take down the write path.
 * @param {string} type
 * @param {object} payload
 */
function emit(type, payload) {
  try {
    bus.emit('event', { type, at: new Date().toISOString(), ...payload });
  } catch (err) {
    /* never throw — dashboard is best-effort */
    console.error('[event-bus] emit failed:', err);
  }
}

/**
 * Subscribe to events. Returns a disposer.
 * @param {(evt: object) => void} handler
 */
function subscribe(handler) {
  const wrapped = (evt) => {
    try {
      handler(evt);
    } catch (err) {
      console.error('[event-bus] handler threw:', err);
    }
  };
  bus.on('event', wrapped);
  return () => bus.off('event', wrapped);
}

module.exports = { emit, subscribe };
