// @ts-check
// Structured logger — emits JSON lines in production, human-readable in development.
//
// Usage:
//   const { log, event } = require('./logger');
//
//   log('info', 'server started', { port: 3000 });
//   event('order.fulfilled', { order_id: id, amount_usd: '10.00', duration_ms: 1234 });
//
// In production (NODE_ENV=production), every call emits a single-line JSON object
// to stdout so log aggregators (Datadog, Loki, CloudWatch) can ingest it directly.
//
// In development/test, emits a compact human-readable string.

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';

function now() {
  return new Date().toISOString();
}

// Safe stringify — handles BigInt (Stellar watcher uses i128 BigInts in
// event payloads) and circular references (Errors with cause chains,
// cached DB rows passed by reference). On any failure, return a
// best-effort JSON object that names the failure and includes the
// original event name / level so observability survives. Adversarial
// audit F2-logger.
function safeStringify(obj) {
  try {
    return JSON.stringify(obj, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      return val;
    });
  } catch (err) {
    // Circular, toJSON throw, or other weird shape. Fall back to a
    // safe payload that preserves the structural fields so log
    // aggregators still see a sensible line.
    const errMsg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      ts: obj?.ts || now(),
      level: obj?.level,
      type: obj?.type,
      msg: obj?.msg,
      event: obj?.event,
      _stringify_error: errMsg,
    });
  }
}

// Wrap a stdout/stderr write so a closed pipe (pm2 restart, rotated
// log file, test that closed the stream) doesn't throw out of the
// logger into the caller's try/catch. Writes are best-effort telemetry
// — dropping is always better than cascading. Adversarial audit F3-logger.
function safeWrite(stream, line) {
  try {
    stream.write(line);
  } catch {
    /* closed pipe / EPIPE / EBADF — drop silently */
  }
}

/**
 * Emit a structured log line.
 * @param {'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function log(level, msg, fields = {}) {
  if (IS_TEST) return; // tests control their own output

  if (IS_PROD) {
    // F1-logger: structural fields (ts, level, msg) spread LAST so a
    // caller-supplied `fields` can't overwrite them. Previously the
    // spread came last, letting any log call with `{ level: 'error' }`
    // or `{ msg: 'spoofed' }` silently corrupt the aggregated log
    // line's shape. The routing check uses the parameter `level` not
    // the merged field, so the JSON would have lied to aggregators
    // while routing to the correct stream.
    const line = safeStringify({ ...fields, ts: now(), level, msg });
    if (level === 'error') {
      safeWrite(process.stderr, line + '\n');
    } else {
      safeWrite(process.stdout, line + '\n');
    }
  } else {
    const prefix = level === 'error' ? '[ERR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    const extra = Object.keys(fields).length ? ' ' + safeStringify(fields) : '';
    console.log(`${prefix} ${msg}${extra}`);
  }
}

/**
 * Emit a business event — used for metrics, auditing, and the live
 * dashboard SSE feed. These are always emitted (never suppressed) so
 * they can be ingested by metrics pipelines regardless of log verbosity.
 *
 * Also forwards a 'bizEvent' event on the in-process event bus so any
 * connected admin/dashboard SSE clients can react in real time — lets
 * us replace the 30s dashboard refresh loop with a push-based model
 * without touching every bizEvent call site.
 *
 * @param {string} name   dot-namespaced event name, e.g. 'order.fulfilled'
 * @param {Record<string, unknown>} [fields]
 */
function event(name, fields = {}) {
  if (!IS_TEST) {
    // F1-logger: same fixed-fields-win discipline as log(). The
    // structural columns (ts, type, event) spread LAST so a caller
    // passing `{ event: 'spoofed', type: 'not-event' }` can't
    // override them. Previously the spread was at the end.
    const line = safeStringify({ ...fields, ts: now(), type: 'event', event: name });
    safeWrite(process.stdout, line + '\n');
  }

  // Lazy-require so the logger module stays a leaf (avoids a circular
  // require path between logger → event-bus → anything that logs).
  try {
    const { emit: busEmit } = require('./event-bus');
    busEmit('biz', { name, fields });
  } catch {
    /* event bus not loaded yet (very early boot) — drop silently */
  }
}

module.exports = { log, event };
