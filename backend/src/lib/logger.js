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

/**
 * Emit a structured log line.
 * @param {'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function log(level, msg, fields = {}) {
  if (IS_TEST) return; // tests control their own output

  if (IS_PROD) {
    const line = JSON.stringify({ ts: now(), level, msg, ...fields });
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  } else {
    const prefix = level === 'error' ? '[ERR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    const extra = Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
    console.log(`${prefix} ${msg}${extra}`);
  }
}

/**
 * Emit a business event — used for metrics and auditing.
 * These are always emitted (never suppressed) so they can be ingested by
 * metrics pipelines regardless of log verbosity setting.
 *
 * @param {string} name   dot-namespaced event name, e.g. 'order.fulfilled'
 * @param {Record<string, unknown>} [fields]
 */
function event(name, fields = {}) {
  if (IS_TEST) return;

  const line = JSON.stringify({ ts: now(), type: 'event', event: name, ...fields });
  process.stdout.write(line + '\n');
}

module.exports = { log, event };
