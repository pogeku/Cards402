// @ts-check
// Pure parser for Cards402 receiver contract events.
//
// Extracted from payments/stellar.js so the same logic can parse events from
// two different sources: (a) the async Soroban event watcher (startWatcher)
// and (b) the synchronous MPP payment verifier. Having one parser ensures
// the two paths never diverge on what counts as a valid payment event.
//
// This module is pure — no DB, no logger, no network. Callers translate the
// result into whatever side effects they need (dead-letter row, log line,
// HTTP response).

const { scValToNative, Address } = require('@stellar/stellar-sdk');

// Convert a non-negative 7-decimal-place i128 (USDC micro-units or XLM
// stroops) to a decimal string. Throws on negative input — the formatter's
// modulus math produces nonsense strings on negative BigInts.
function stroopsToDecimal(i128) {
  if (typeof i128 !== 'bigint') throw new Error('stroopsToDecimal: expected bigint');
  if (i128 < 0n) throw new Error('stroopsToDecimal: negative amount');
  const whole = i128 / 10_000_000n;
  const frac = String(i128 % 10_000_000n).padStart(7, '0');
  return `${whole}.${frac}`;
}

/**
 * Parse a Soroban event from the receiver contract into a dispatch payload
 * the rest of the system understands.
 *
 * Event shape expected from the receiver contract:
 *   topic[0] = Symbol("pay_usdc") or Symbol("pay_xlm")
 *   topic[1] = Bytes(order_id utf-8)
 *   topic[2] = Address(from)
 *   value    = i128 amount (micro-USDC or stroops)
 *
 * Returns one of:
 *   { ok: true, payload }                 — dispatch this
 *   { ok: false, kind: 'skip' }           — silently skip (topic too short)
 *   { ok: false, kind: 'unknown_symbol', symbol } — log, no dead-letter
 *   { ok: false, kind: 'parse_error', error }     — dead-letter it
 *
 * @param {any} event
 */
function parsePaymentEvent(event) {
  // Topic too short — not one of our events, skip silently.
  if (!event?.topic || event.topic.length < 3) {
    return { ok: false, kind: 'skip' };
  }

  let eventSymbol, orderId, senderAddress, amountDecimal;
  try {
    eventSymbol = scValToNative(event.topic[0]); // 'pay_usdc' or 'pay_xlm'

    // Cap orderId bytes before Buffer allocation. A malformed/hostile event
    // with a 10KB orderId would otherwise bloat logs + downstream params.
    // UUIDs are 36 chars; our short-ids are well under 64.
    const orderIdBytes = scValToNative(event.topic[1]);
    if (!orderIdBytes || orderIdBytes.length === 0 || orderIdBytes.length > 64) {
      throw new Error(`orderId bytes length out of range: ${orderIdBytes?.length}`);
    }
    orderId = Buffer.from(orderIdBytes).toString('utf-8');
    // Reject non-printable / control bytes in the decoded order id.
    if (!/^[\x20-\x7e]+$/.test(orderId)) {
      throw new Error('orderId contains non-printable bytes');
    }

    senderAddress = Address.fromScVal(event.topic[2]).toString();

    // Enforce non-negative, non-zero amount at parse time. Zero is a no-op,
    // negative is either a bug or an attack. Either way it belongs in the
    // dead-letter table, not dispatched.
    const amountI128 = BigInt(scValToNative(event.value));
    if (amountI128 <= 0n) {
      throw new Error(`non-positive amount i128: ${amountI128}`);
    }
    amountDecimal = stroopsToDecimal(amountI128);
  } catch (err) {
    return {
      ok: false,
      kind: 'parse_error',
      error: /** @type {Error} */ (err).message,
    };
  }

  if (eventSymbol === 'pay_usdc') {
    return {
      ok: true,
      payload: {
        txid: event.txHash,
        paymentAsset: 'usdc_soroban',
        amountUsdc: amountDecimal,
        amountXlm: null,
        senderAddress,
        orderId,
        eventSymbol,
      },
    };
  }
  if (eventSymbol === 'pay_xlm') {
    return {
      ok: true,
      payload: {
        txid: event.txHash,
        paymentAsset: 'xlm_soroban',
        amountUsdc: null,
        amountXlm: amountDecimal,
        senderAddress,
        orderId,
        eventSymbol,
      },
    };
  }

  return { ok: false, kind: 'unknown_symbol', symbol: String(eventSymbol) };
}

module.exports = { parsePaymentEvent, stroopsToDecimal };
