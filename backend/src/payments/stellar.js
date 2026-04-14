// @ts-check
// Soroban payment watcher — polls the Cards402 receiver contract for payment events.
//
// Watches for two event types from the same contract:
//   pay_usdc — agent paid USDC; topic[0]=Symbol("pay_usdc"), value=micro-USDC i128
//   pay_xlm  — agent paid XLM;  topic[0]=Symbol("pay_xlm"),  value=stroops i128
//
// The last-seen ledger is persisted to the database so no payments are missed
// across restarts of any duration.

const { rpc, scValToNative, Address } = require('@stellar/stellar-sdk');
const { event: bizEvent } = require('../lib/logger');
const db = require('../db');

const NETWORK = process.env.STELLAR_NETWORK || 'mainnet';
const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ||
  (NETWORK === 'mainnet'
    ? 'https://mainnet.sorobanrpc.com'
    : 'https://soroban-testnet.stellar.org');
const RECEIVER_CONTRACT_ID = process.env.RECEIVER_CONTRACT_ID;

const rpcServer = new rpc.Server(SOROBAN_RPC_URL);

// (topic filter removed — mainnet Soroban RPC does not match topic XDR correctly;
//  events are filtered by symbol in handlePaymentEvent instead)

// ── Cursor persistence ────────────────────────────────────────────────────────

function loadStartLedger() {
  const v = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'stellar_start_ledger'`).get()
  )?.value;
  if (!v) return null;
  const parsed = parseInt(v, 10);
  // Defence in depth against a corrupted system_state row. A NaN or
  // negative cursor would either loop forever against the RPC or
  // replay from ledger 0 — both are bad. Treat any non-positive-
  // integer value as "no cursor" and let poll() re-anchor to the
  // current latest ledger.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[stellar] stellar_start_ledger has invalid value ${JSON.stringify(v)} — ignoring`,
    );
    return null;
  }
  return parsed;
}

function saveStartLedger(ledger) {
  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger', ?)`,
  ).run(String(ledger));
  // Track the wall-clock of each cursor advance so /status can tell
  // whether the watcher is still making progress. Stored as a separate
  // key (system_state is (key, value) only — no per-row updated_at).
  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger_at', ?)`,
  ).run(new Date().toISOString());
  // Audit A-12: nudge the WAL to the main db file so a hard-crash doesn't
  // lose the cursor. PASSIVE is non-blocking and cheap; we're only
  // advancing the cursor a few times per second. The global txid dedupe
  // in index.js still covers any events replayed on crash recovery, so
  // the checkpoint is belt-and-braces.
  try {
    db.prepare(`PRAGMA wal_checkpoint(PASSIVE)`).run();
  } catch (_) {}
}

// ── Watcher ───────────────────────────────────────────────────────────────────

// Shutdown flag checked by the poll loop on every scheduling tick.
// Set by the teardown function returned from startWatcher() so the
// SIGINT/SIGTERM handler in index.js can stop the watcher cleanly —
// in-flight getEvents() / onPayment work finishes, but no new poll
// is scheduled, and the handler's server.close() timeout doesn't
// fight a re-scheduling setTimeout.
let shutdownRequested = false;

function startWatcher(onPayment, log = console.log) {
  if (!RECEIVER_CONTRACT_ID) throw new Error('RECEIVER_CONTRACT_ID not set');
  log(`[stellar] watching receiver contract ${RECEIVER_CONTRACT_ID} on ${NETWORK}`);
  shutdownRequested = false;
  poll(onPayment, log);
  return function stopWatcher() {
    shutdownRequested = true;
    log('[stellar] watcher stop requested — will drain after current poll');
  };
}

async function poll(onPayment, log) {
  try {
    let sl = loadStartLedger();
    if (!sl) {
      const latest = await rpcServer.getLatestLedger();
      sl = Math.max(1, latest.sequence - 100);
      saveStartLedger(sl);
    }

    const result = await rpcServer.getEvents(
      /** @type {any} */ ({
        startLedger: sl,
        filters: [
          {
            type: 'contract',
            contractIds: [RECEIVER_CONTRACT_ID],
            // No topic filter — mainnet RPC topic XDR matching is unreliable;
            // events are filtered by symbol in handlePaymentEvent instead.
          },
        ],
        pagination: { limit: 200 },
      }),
    );
    const events = result.events ?? [];

    for (const event of events) {
      await handlePaymentEvent(event, onPayment, log);
    }

    if (events.length > 0) {
      // Advance past the last processed event's ledger. All events in a batch
      // share the same or increasing ledger numbers. Re-processing the same tx
      // is safe — index.js has a global txid duplicate guard.
      //
      // F3 batch-saturation warning. If a single ledger has more events
      // on our contract than the batch limit (200), we currently advance
      // past that ledger and lose events 201+ in it because the getEvents
      // call here doesn't use the response cursor for intra-ledger
      // pagination. At cards402 scale this should never happen (a
      // handful of payments per ledger at most), so we emit a loud
      // bizEvent + log so the operator can correlate it with any
      // missing-payment investigation. Proper cursor-based pagination
      // is tracked as a follow-up — this at least surfaces the edge
      // case instead of silently dropping events.
      if (events.length >= 200) {
        const firstLedger = events[0].ledger;
        const lastLedger = events[events.length - 1].ledger;
        if (firstLedger === lastLedger) {
          log(
            `[stellar] WARN batch saturated at 200 events in single ledger ${lastLedger} — events 201+ in that ledger may be lost`,
          );
          bizEvent('stellar.batch_saturated_single_ledger', {
            ledger: lastLedger,
            batch_size: events.length,
          });
        }
      }
      saveStartLedger(events[events.length - 1].ledger + 1);
    } else if (result.latestLedger) {
      saveStartLedger(result.latestLedger);
    }

    // Watcher poll interval: tight enough to keep pickup latency under ~1s,
    // loose enough not to rate-limit the public mainnet Soroban RPC.
    // Override via WATCHER_POLL_INTERVAL_MS if you're running a dedicated RPC
    // or want to trade RPC load against latency differently. Error path is
    // backed off 4× to avoid hammering a broken endpoint.
    if (shutdownRequested) return;
    const POLL_MS = parseInt(process.env.WATCHER_POLL_INTERVAL_MS || '1500', 10);
    setTimeout(() => poll(onPayment, log), events.length === 200 ? 0 : POLL_MS);
  } catch (err) {
    const POLL_MS = parseInt(process.env.WATCHER_POLL_INTERVAL_MS || '1500', 10);

    // Self-healing for cursor-out-of-range errors. Soroban public RPC
    // only retains ~24 hours (~170k ledgers) of event history. If our
    // cursor falls outside that window — which happens after a long
    // outage, restart delay, or if the RPC history cutoff moves past
    // us faster than we poll — every subsequent getEvents() call
    // fails with "startLedger must be within the ledger range: X - Y".
    // Without self-healing, the watcher gets stuck retrying the same
    // out-of-range cursor forever and every on-chain payment during
    // the stuck window is silently missed.
    //
    // Recovery: parse the upper bound from the error message and jump
    // the cursor to that ledger minus a small margin. Events between
    // our old cursor and the new one are lost — but they were ALREADY
    // lost the moment they fell outside the retention window. At
    // least new events are picked up instead of silently failing
    // forever. Emit a distinct bizEvent so ops can correlate the
    // recovery with the missing-payment window.
    //
    // This matches the bug pattern bit shawn@rozo.ai: two stranded
    // $30 USDC orders with zero on-chain footprint from our side,
    // because our watcher was stuck in this exact error loop.
    const msg = err?.message || '';
    const outOfRangeMatch = msg.match(/startLedger must be within the ledger range: (\d+) - (\d+)/);
    if (outOfRangeMatch) {
      const upper = parseInt(outOfRangeMatch[2], 10);
      if (Number.isFinite(upper) && upper > 0) {
        // Resume at upper - 100 so we get a bit of buffer but don't
        // try to re-scan the whole retention window in one batch.
        const resumeAt = Math.max(1, upper - 100);
        const oldCursor = loadStartLedger();
        saveStartLedger(resumeAt);
        log(`[stellar] cursor ${oldCursor} fell outside RPC retention; resetting to ${resumeAt}`);
        bizEvent('stellar.cursor_reset_out_of_range', {
          old_cursor: oldCursor,
          new_cursor: resumeAt,
          rpc_lower: parseInt(outOfRangeMatch[1], 10),
          rpc_upper: upper,
        });
        // Retry quickly — the reset cursor is valid, no need to wait
        // the 4× backoff we'd apply for generic RPC flakiness.
        if (shutdownRequested) return;
        setTimeout(() => poll(onPayment, log), POLL_MS);
        return;
      }
    }

    log(`[stellar] poll error: ${err.message} — retrying in ${POLL_MS * 4}ms`);
    // Emit a bizEvent so RPC flakiness and rethrown dispatch failures are
    // visible in the metrics pipeline, not just stderr. Cheap because poll
    // errors are rare — the hot path is success, which doesn't emit this.
    bizEvent('stellar.poll_error', { error: err.message });
    if (shutdownRequested) return;
    setTimeout(() => poll(onPayment, log), POLL_MS * 4);
  }
}

// Convert a non-negative 7-decimal-place i128 (USDC micro-units or XLM
// stroops) to a decimal string. Asserts non-negative input because the
// formatter's modulus math produces nonsense strings on negative BigInts
// (e.g. -5_000_000n → "0.-5000000"), and the only path that could feed
// a negative i128 here is a malformed/hostile contract event which is
// already being rejected upstream at parse time. Keeping the assertion
// as belt-and-braces for any future caller.
function stroopsToDecimal(i128) {
  if (typeof i128 !== 'bigint') throw new Error('stroopsToDecimal: expected bigint');
  if (i128 < 0n) throw new Error('stroopsToDecimal: negative amount');
  const whole = i128 / 10_000_000n;
  const frac = String(i128 % 10_000_000n).padStart(7, '0');
  return `${whole}.${frac}`;
}

// Serialise an arbitrary Soroban event for the dead-letter table. Events
// contain BigInts (the XDR decoder hands them back for i128 slots) which
// JSON.stringify refuses by default; coerce them to strings so the dead
// letter row is diffable and can be replayed by an operator.
function serialiseEventForDeadLetter(event) {
  try {
    return JSON.stringify(event, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch (e) {
    return `serialisation_failed: ${e.message}`;
  }
}

async function handlePaymentEvent(event, onPayment, log) {
  // Two-phase split:
  //   1. Parse — pulling fields out of the event XDR. Failures here are
  //      permanent (a malformed event will never parse cleanly) so we
  //      dead-letter for forensic recovery and return, letting the
  //      caller advance the cursor past this ledger.
  //   2. Dispatch — passing the parsed payload to onPayment. Failures
  //      here are likely transient (DB hiccup, lock contention, disk
  //      full) so we rethrow and let the outer poll() catch back off
  //      and retry the whole batch. index.js's global txid dedupe makes
  //      the retry idempotent.
  //
  // Before this split, both cases were caught and swallowed, so a
  // transient DB error during onPayment silently advanced the cursor
  // past a real payment — losing the event forever with no trace. See
  // db.js migration 23.

  let parsed;
  try {
    if (event.topic.length < 3) return;

    // topic[0] = Symbol("pay_usdc") or Symbol("pay_xlm")
    // topic[1] = Bytes(order_id utf-8)
    // topic[2] = Address(from)
    // value    = i128 amount (micro-USDC or stroops)
    const eventSymbol = scValToNative(event.topic[0]); // 'pay_usdc' or 'pay_xlm'

    // F2: cap the orderId bytes length before the Buffer allocation.
    // A malformed/hostile contract event with a 10KB orderId would
    // otherwise bloat logs, dead-letter rows, and the downstream SQL
    // parameter. UUIDs are 36 chars and our short-ids top out well
    // below 64; anything larger is definitionally invalid.
    const orderIdBytes = scValToNative(event.topic[1]);
    if (!orderIdBytes || orderIdBytes.length === 0 || orderIdBytes.length > 64) {
      throw new Error(`orderId bytes length out of range: ${orderIdBytes?.length}`);
    }
    const orderId = Buffer.from(orderIdBytes).toString('utf-8');
    // Reject non-printable / control bytes — a well-formed order id is
    // ASCII hex with dashes. Anything else is an attempt to smuggle
    // control chars into log lines or the SQL parameter.
    if (!/^[\x20-\x7e]+$/.test(orderId)) {
      throw new Error('orderId contains non-printable bytes');
    }

    const senderAddress = Address.fromScVal(event.topic[2]).toString();

    // F1 + F4: enforce non-negative, non-zero amount at parse time.
    // A zero event is a no-op that shouldn't traverse the pipeline,
    // and a negative one is either a bug or an attack. Either way it
    // belongs in the dead-letter table, not dispatched to onPayment.
    const amountI128 = BigInt(scValToNative(event.value));
    if (amountI128 <= 0n) {
      throw new Error(`non-positive amount i128: ${amountI128}`);
    }
    const amountDecimal = stroopsToDecimal(amountI128);

    parsed = { eventSymbol, orderId, senderAddress, amountDecimal };
  } catch (err) {
    log(`[stellar] event parse error at ledger ${event.ledger} tx=${event.txHash}: ${err.message}`);
    bizEvent('stellar.event_parse_error', {
      ledger: event.ledger,
      tx_hash: event.txHash,
      error: err.message,
    });
    try {
      db.prepare(
        `INSERT OR IGNORE INTO stellar_dead_letter (tx_hash, ledger, raw_event, error)
         VALUES (?, ?, ?, ?)`,
      ).run(event.txHash, event.ledger, serialiseEventForDeadLetter(event), err.message);
    } catch (dbErr) {
      log(`[stellar] dead-letter insert failed for ${event.txHash}: ${dbErr.message}`);
    }
    return;
  }

  const { eventSymbol, orderId, senderAddress, amountDecimal } = parsed;

  if (eventSymbol === 'pay_usdc') {
    log(
      `[stellar] pay_usdc: $${amountDecimal} USDC, order=${orderId}, from=${senderAddress}, tx=${event.txHash}`,
    );
    bizEvent('payment.received', {
      asset: 'usdc',
      amount: amountDecimal,
      order_id: orderId,
      txid: event.txHash,
    });
    await onPayment({
      txid: event.txHash,
      paymentAsset: 'usdc_soroban',
      amountUsdc: amountDecimal,
      amountXlm: null,
      senderAddress,
      orderId,
    });
  } else if (eventSymbol === 'pay_xlm') {
    log(
      `[stellar] pay_xlm: ${amountDecimal} XLM, order=${orderId}, from=${senderAddress}, tx=${event.txHash}`,
    );
    bizEvent('payment.received', {
      asset: 'xlm',
      amount: amountDecimal,
      order_id: orderId,
      txid: event.txHash,
    });
    await onPayment({
      txid: event.txHash,
      paymentAsset: 'xlm_soroban',
      amountUsdc: null,
      amountXlm: amountDecimal,
      senderAddress,
      orderId,
    });
  } else {
    log(`[stellar] unknown event symbol: ${eventSymbol} tx=${event.txHash}`);
    bizEvent('stellar.unknown_event_symbol', {
      ledger: event.ledger,
      tx_hash: event.txHash,
      symbol: String(eventSymbol),
    });
  }
}

module.exports = { startWatcher, handlePaymentEvent };
