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
  return v ? parseInt(v) : null;
}

function saveStartLedger(ledger) {
  db.prepare(
    `INSERT OR REPLACE INTO system_state (key, value) VALUES ('stellar_start_ledger', ?)`,
  ).run(String(ledger));
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

function startWatcher(onPayment, log = console.log) {
  if (!RECEIVER_CONTRACT_ID) throw new Error('RECEIVER_CONTRACT_ID not set');
  log(`[stellar] watching receiver contract ${RECEIVER_CONTRACT_ID} on ${NETWORK}`);
  poll(onPayment, log);
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
      saveStartLedger(events[events.length - 1].ledger + 1);
    } else if (result.latestLedger) {
      saveStartLedger(result.latestLedger);
    }

    // Watcher poll interval: tight enough to keep pickup latency under ~1s,
    // loose enough not to rate-limit the public mainnet Soroban RPC.
    // Override via WATCHER_POLL_INTERVAL_MS if you're running a dedicated RPC
    // or want to trade RPC load against latency differently. Error path is
    // backed off 4× to avoid hammering a broken endpoint.
    const POLL_MS = parseInt(process.env.WATCHER_POLL_INTERVAL_MS || '1500', 10);
    setTimeout(() => poll(onPayment, log), events.length === 200 ? 0 : POLL_MS);
  } catch (err) {
    const POLL_MS = parseInt(process.env.WATCHER_POLL_INTERVAL_MS || '1500', 10);
    log(`[stellar] poll error: ${err.message} — retrying in ${POLL_MS * 4}ms`);
    setTimeout(() => poll(onPayment, log), POLL_MS * 4);
  }
}

// Convert a 7-decimal-place i128 (USDC micro-units or XLM stroops) to a decimal string.
function stroopsToDecimal(i128) {
  const whole = i128 / 10_000_000n;
  const frac = String(i128 % 10_000_000n).padStart(7, '0');
  return `${whole}.${frac}`;
}

async function handlePaymentEvent(event, onPayment, log) {
  try {
    if (event.topic.length < 3) return;

    // topic[0] = Symbol("pay_usdc") or Symbol("pay_xlm")
    // topic[1] = Bytes(order_id utf-8)
    // topic[2] = Address(from)
    // value    = i128 amount (micro-USDC or stroops)
    const eventSymbol = scValToNative(event.topic[0]); // 'pay_usdc' or 'pay_xlm'
    const orderIdBytes = scValToNative(event.topic[1]);
    const orderId = Buffer.from(orderIdBytes).toString('utf-8');
    const senderAddress = Address.fromScVal(event.topic[2]).toString();

    const amountI128 = BigInt(scValToNative(event.value));
    const amountDecimal = stroopsToDecimal(amountI128);

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
      log(`[stellar] unknown event symbol: ${eventSymbol}`);
    }
  } catch (err) {
    log(`[stellar] error handling event: ${err.message}`);
  }
}

module.exports = { startWatcher };
