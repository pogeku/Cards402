require('dotenv').config();
require('./env');

const app = require('./app');
const { startJobs, stopJobs } = require('./jobs');
const { startWatcher } = require('./payments/stellar');
const { handlePayment } = require('./payment-handler');
const { event: bizEvent } = require('./lib/logger');
const { formatRejection } = require('./lib/process-handlers');

startJobs();

const stopWatcher = startWatcher(handlePayment);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(
    `[cards402] backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`,
  );
});

// Graceful shutdown sequence. pm2 sends SIGINT on graceful stop
// (default) and SIGTERM on `pm2 stop` without --kill-retry-delay —
// handle both identically so a deploy-time restart drains in-flight
// work instead of forcing a SIGKILL when pm2's grace period elapses.
//
// Order of operations:
//   1. Stop the Soroban watcher from scheduling new polls. Any
//      in-flight poll() call is allowed to finish — the shutdownRequested
//      flag gates only the re-scheduling setTimeout inside poll().
//   2. Cancel every background job interval (runJobs, funding check,
//      alert evaluator). In-flight jobs are already guarded by their
//      own jobsRunning mutex and will complete naturally.
//   3. Close the HTTP server — stops accepting new connections,
//      drains in-flight requests.
//   4. Exit clean once server.close() callback fires. Hard-exit
//      after 15 seconds as a fallback so a stuck socket can't hold
//      pm2 past its grace period (pm2's default is ~1600 ms, but
//      cards402-api is configured with a longer kill_timeout in
//      the ecosystem file so 15 s gives comfortable headroom).
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cards402] ${signal} — draining and shutting down`);
  try {
    stopWatcher?.();
  } catch (err) {
    console.error('[cards402] stopWatcher error:', err);
  }
  try {
    stopJobs();
  } catch (err) {
    console.error('[cards402] stopJobs error:', err);
  }
  server.close((err) => {
    if (err) {
      console.error('[cards402] server.close error:', err);
      process.exit(1);
    }
    console.log('[cards402] shutdown complete');
    process.exit(0);
  });
  // Fallback hard-exit if server.close() never fires (stuck socket,
  // runaway SSE stream, pm2 grace window about to close). 15 s is
  // long enough for in-flight requests to drain at normal latency
  // but short enough that pm2's kill_timeout doesn't force SIGKILL
  // before we log the "shutdown complete" line.
  setTimeout(() => {
    console.error('[cards402] shutdown timeout — forcing exit');
    process.exit(1);
  }, 15_000).unref();
}
// F1-index (2026-04-16): SIGHUP was previously unhandled, so a pm2
// reload / systemd HUP / Docker stop would terminate the process via
// Node's default SIGHUP behaviour without draining in-flight orders,
// SSE streams, or webhook deliveries. Route it through the same
// graceful-shutdown path as SIGINT/SIGTERM.
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// F2-index (2026-04-16): the process-level error handlers emit a
// structured payload via src/lib/process-handlers.js::formatRejection
// rather than relying on Node's default stringification (which
// produces `[object Promise]` for the promise arg of
// unhandledRejection — nearly useless). The formatter is in its own
// module so it can be unit-tested without loading index.js, which
// runs production side effects (startJobs, startWatcher, app.listen,
// signal registration) at module load.
//
// Crash handlers. Unhandled exceptions in a setInterval callback or
// an unhandled promise rejection in a background task would otherwise
// crash the process silently via Node's default behaviour — by then
// pm2 restarts us but we've lost the opportunity to log the crash
// with enough context for post-mortem. Log loudly, then fall back to
// the graceful shutdown path so in-flight work gets a chance to
// complete.
process.on('uncaughtException', (err, origin) => {
  console.error(`[cards402] uncaughtException at ${origin}:`, err);
  try {
    bizEvent('process.uncaught_exception', {
      origin,
      ...formatRejection(err),
    });
  } catch {
    /* observability must never re-crash the handler */
  }
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  const payload = formatRejection(reason);
  // Keep the stderr line so it shows up in operator consoles even if
  // the logger module itself is broken, but make the message useful
  // now — pre-fix this stringified the Promise as `[object Promise]`.
  console.error(
    `[cards402] unhandledRejection: ${payload.name}: ${payload.message}${
      payload.stack ? `\n${payload.stack}` : ''
    }`,
  );
  try {
    bizEvent('process.unhandled_rejection', payload);
  } catch {
    /* see above */
  }
  // Don't shut down on every unhandled rejection — Node 22 still
  // logs a warning and continues by default, and the app has many
  // fire-and-forget .catch(() => {}) branches where a late reject
  // isn't fatal. Log and let the request finish.
});

// Note: this file has no module.exports. It's the production
// entrypoint — consumers that want a testable surface should import
// from the individual modules (./app, ./jobs, ./payments/stellar,
// ./lib/process-handlers, etc.) directly.
