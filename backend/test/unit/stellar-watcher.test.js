// Unit tests for backend/src/payments/stellar.js — the Soroban payment watcher.
//
// Covers the two adversarial-audit findings shipped with this test:
//
//   F1: cursor pagination correctness (exercised indirectly via the
//       parse/dispatch path — end-to-end cursor behaviour needs a real
//       RPC mock and is not covered here).
//
//   F2: poison-pill starvation. An onPayment dispatch that consistently
//       throws MUST be dead-lettered after MAX_DISPATCH_RETRIES so the
//       watcher can advance the cursor past it. Without this, one
//       broken event blocks every subsequent payment forever.
//
// Also pins the existing parse-time guards: bad orderId bytes, non-
// printable orderId, non-positive i128, wrong topic shape, etc. These
// are regression guards for migration 23 (dead-letter table) and the
// F1/F2/F4 parse guards added to handlePaymentEvent.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { xdr, Address, nativeToScVal, Keypair } = require('@stellar/stellar-sdk');

const db = require('../../src/db');
const {
  handlePaymentEvent,
  _resetDispatchRetries,
  _getDispatchRetryMapSize,
  _peekDispatchRetry,
  _serialiseEventForDeadLetter,
  _DISPATCH_RETRY_CAP,
  _MAX_DISPATCH_RETRIES,
  _DEAD_LETTER_CAP_BYTES,
} = require('../../src/payments/stellar');

// ── Event fixture builders ──────────────────────────────────────────────────

const FAKE_SENDER = Keypair.random().publicKey();

let eventSeq = 0;

function makeEvent({
  symbol = 'pay_usdc',
  orderId = 'order-abc-1',
  from = FAKE_SENDER,
  amount = 250000n, // 0.025 USDC in 7-decimal micro units
  topicLength = 3,
  // Escape hatches — let tests inject raw ScVals for the parse-error cases.
  rawTopic = null,
  rawValue = null,
} = {}) {
  eventSeq += 1;
  const fullTopic = [
    xdr.ScVal.scvSymbol(symbol),
    nativeToScVal(Buffer.from(orderId, 'utf-8'), { type: 'bytes' }),
    new Address(from).toScVal(),
  ];
  const topic = rawTopic ?? fullTopic.slice(0, topicLength);
  const value = rawValue ?? nativeToScVal(amount, { type: 'i128' });
  return {
    id: `evt-${eventSeq}`,
    ledger: 1_000_000 + eventSeq,
    txHash: `TXHASH${eventSeq.toString().padStart(56, '0')}`,
    topic,
    value,
  };
}

function silentLog() {
  /* no-op log for tests */
}

function countDeadLetterRows() {
  return db.prepare(`SELECT COUNT(*) AS n FROM stellar_dead_letter`).get().n;
}

function getDeadLetterRow(txHash) {
  return db.prepare(`SELECT * FROM stellar_dead_letter WHERE tx_hash = ?`).get(txHash);
}

beforeEach(() => {
  db.prepare(`DELETE FROM stellar_dead_letter`).run();
  _resetDispatchRetries();
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe('handlePaymentEvent — happy path', () => {
  it('dispatches pay_usdc with the expected payload shape', async () => {
    const calls = [];
    const onPayment = async (payload) => {
      calls.push(payload);
    };

    const event = makeEvent({ symbol: 'pay_usdc', amount: 250_000n });
    await handlePaymentEvent(event, onPayment, silentLog);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].paymentAsset, 'usdc_soroban');
    assert.equal(calls[0].amountUsdc, '0.0250000');
    assert.equal(calls[0].amountXlm, null);
    assert.equal(calls[0].orderId, 'order-abc-1');
    assert.equal(calls[0].txid, event.txHash);
    assert.equal(countDeadLetterRows(), 0);
  });

  it('dispatches pay_xlm with amountXlm set and amountUsdc null', async () => {
    const calls = [];
    const event = makeEvent({ symbol: 'pay_xlm', amount: 15_000_000n });
    await handlePaymentEvent(event, async (p) => calls.push(p), silentLog);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].paymentAsset, 'xlm_soroban');
    assert.equal(calls[0].amountXlm, '1.5000000');
    assert.equal(calls[0].amountUsdc, null);
  });

  it('ignores unknown event symbols without dispatching or dead-lettering', async () => {
    const calls = [];
    const event = makeEvent({ symbol: 'refund_stellar' });
    await handlePaymentEvent(event, async (p) => calls.push(p), silentLog);

    assert.equal(calls.length, 0);
    assert.equal(countDeadLetterRows(), 0);
  });
});

// ── Parse-time guards ──────────────────────────────────────────────────────

describe('handlePaymentEvent — parse guards dead-letter bad events', () => {
  it('returns silently on short topic arrays (no dead-letter)', async () => {
    // Short topic (<3) is "not a payment event" — e.g. an admin/debug event
    // on the receiver contract. It's not an error, just not for us.
    const calls = [];
    const event = makeEvent({ topicLength: 2 });
    await handlePaymentEvent(event, async (p) => calls.push(p), silentLog);
    assert.equal(calls.length, 0);
    assert.equal(countDeadLetterRows(), 0);
  });

  it('dead-letters events with zero-length orderId bytes', async () => {
    const event = makeEvent({ orderId: '' });
    await handlePaymentEvent(event, async () => {}, silentLog);
    const row = getDeadLetterRow(event.txHash);
    assert.ok(row, 'expected dead-letter row');
    assert.match(row.error, /orderId bytes length/);
  });

  it('dead-letters events with orderId > 64 bytes', async () => {
    const event = makeEvent({ orderId: 'a'.repeat(100) });
    await handlePaymentEvent(event, async () => {}, silentLog);
    const row = getDeadLetterRow(event.txHash);
    assert.ok(row);
    assert.match(row.error, /orderId bytes length/);
  });

  it('dead-letters events with non-printable bytes in orderId', async () => {
    const event = makeEvent({ orderId: 'order\x01abc' });
    await handlePaymentEvent(event, async () => {}, silentLog);
    const row = getDeadLetterRow(event.txHash);
    assert.ok(row);
    assert.match(row.error, /non-printable/);
  });

  it('dead-letters events with zero i128 amount', async () => {
    const event = makeEvent({ amount: 0n });
    await handlePaymentEvent(event, async () => {}, silentLog);
    const row = getDeadLetterRow(event.txHash);
    assert.ok(row);
    assert.match(row.error, /non-positive amount/);
  });

  it('dead-letters events with negative i128 amount', async () => {
    const event = makeEvent({ amount: -1n });
    await handlePaymentEvent(event, async () => {}, silentLog);
    const row = getDeadLetterRow(event.txHash);
    assert.ok(row);
    assert.match(row.error, /non-positive amount/);
  });
});

// ── F2: poison-pill dead-letter on consistent dispatch failures ────────────

describe('handlePaymentEvent — F2 poison-pill retry bounding', () => {
  it('rethrows dispatch errors below MAX_DISPATCH_RETRIES (first attempts)', async () => {
    const event = makeEvent();
    let calls = 0;
    const onPayment = async () => {
      calls += 1;
      throw new Error('db is locked');
    };

    // Attempts 1..4 should all rethrow — the watcher retries via outer poll.
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        handlePaymentEvent(event, onPayment, silentLog),
        /db is locked/,
        `attempt ${i + 1} should rethrow`,
      );
    }
    assert.equal(calls, 4);
    // Below the threshold, no dead-letter yet.
    assert.equal(countDeadLetterRows(), 0);
  });

  it('dead-letters and returns on the 5th consecutive dispatch failure', async () => {
    const event = makeEvent();
    let calls = 0;
    const onPayment = async () => {
      calls += 1;
      throw new Error('constraint violation');
    };

    // Attempts 1..4 rethrow.
    for (let i = 0; i < 4; i++) {
      await assert.rejects(handlePaymentEvent(event, onPayment, silentLog), /constraint violation/);
    }
    // Attempt 5 MUST NOT throw — it dead-letters and returns so the
    // watcher's for-loop can advance past the poison event. This is
    // the whole point of the F2 fix.
    await handlePaymentEvent(event, onPayment, silentLog);

    assert.equal(calls, 5, 'onPayment should be called 5 times total');
    const row = getDeadLetterRow(event.txHash);
    assert.ok(row, 'expected dead-letter row on 5th attempt');
    assert.match(row.error, /dispatch_poison.*constraint violation/);
  });

  it('clears the retry counter when dispatch eventually succeeds', async () => {
    const event = makeEvent();
    let calls = 0;
    const onPayment = async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      // Third call succeeds.
    };

    // Two transient failures...
    await assert.rejects(handlePaymentEvent(event, onPayment, silentLog));
    await assert.rejects(handlePaymentEvent(event, onPayment, silentLog));
    // ...then a success resets the counter.
    await handlePaymentEvent(event, onPayment, silentLog);

    // If the counter was still at 2, a subsequent failing call would
    // hit 3 (not the 5-threshold) and rethrow. Re-send the same event
    // with a fresh always-throwing onPayment and confirm we need
    // another 5 attempts to poison it — i.e. the counter reset cleanly.
    let calls2 = 0;
    const onPayment2 = async () => {
      calls2 += 1;
      throw new Error('fresh err');
    };
    for (let i = 0; i < 4; i++) {
      await assert.rejects(handlePaymentEvent(event, onPayment2, silentLog));
    }
    // Still no dead-letter after 4 fresh failures — proves the counter
    // reset after the success and didn't carry the prior 2 over.
    assert.equal(countDeadLetterRows(), 0);
    // 5th poisons.
    await handlePaymentEvent(event, onPayment2, silentLog);
    assert.ok(getDeadLetterRow(event.txHash));
    assert.equal(calls2, 5);
  });

  it('tracks different events independently', async () => {
    const eventA = makeEvent({ orderId: 'order-a' });
    const eventB = makeEvent({ orderId: 'order-b' });

    let callsA = 0;
    let callsB = 0;
    const onPaymentA = async () => {
      callsA += 1;
      throw new Error('A fail');
    };
    const onPaymentB = async () => {
      callsB += 1;
      // B succeeds on first call
    };

    // Fail event A four times — below threshold, no dead-letter yet.
    for (let i = 0; i < 4; i++) {
      await assert.rejects(handlePaymentEvent(eventA, onPaymentA, silentLog));
    }
    // Event B succeeds once. Its counter should be independent of A's.
    await handlePaymentEvent(eventB, onPaymentB, silentLog);

    // A still has 4 failures pending; one more should dead-letter it.
    await handlePaymentEvent(eventA, onPaymentA, silentLog);
    assert.equal(callsA, 5);
    assert.equal(callsB, 1);
    assert.ok(getDeadLetterRow(eventA.txHash));
    assert.equal(getDeadLetterRow(eventB.txHash), undefined);
  });
});

// ── F1-stellar: dispatch-retry map saturation behaviour ─────────────────────
//
// Pre-fix the map had a 1024-entry "LRU" eviction that was actually FIFO,
// and JS Map.set() on an existing key did NOT reorder the entry. An
// actively-poisoning event near MAX_DISPATCH_RETRIES could be evicted
// at the exact moment the map hit the cap, and when the same batch was
// re-dispatched (the watcher outer catch rethrow keeps the cursor
// stuck), its counter restarted from 1. The poison-pill breakout that
// the whole mechanism exists to guarantee was silently defeated under
// load. Post-fix: cap raised to 8192 and eviction eliminated entirely;
// new events beyond the cap are immediately dead-lettered and a
// one-shot bizEvent flags the saturation for ops.

describe('F1-stellar: dispatch-retry map saturation', () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM stellar_dead_letter`).run();
    _resetDispatchRetries();
  });

  it('retry counter persists across attempts for the same event id (no eviction)', async () => {
    // Fill the map up to (cap - 1) entries with distinct "noise" events,
    // then run 4 attempts on a specific event and verify its counter
    // is still at 4 (not reset due to eviction).
    //
    // We avoid actually failing cap-minus-1 events (that would dead-
    // letter too many) — instead we poke the internal counter directly
    // by running real handlePaymentEvent calls on 100 distinct events
    // and checking none of them evicts the others.
    const events = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeEvent({ orderId: `noise-${i}` }));
    }
    const onPayment = async () => {
      throw new Error('fail');
    };
    // Each noise event fails once — 100 entries now in the map.
    for (const e of events) {
      await assert.rejects(handlePaymentEvent(e, onPayment, silentLog));
    }
    assert.equal(_getDispatchRetryMapSize(), 100);

    // Now run the critical event 4 times. Its counter should reach 4,
    // NOT be evicted or reset by the 100 noise entries.
    const critical = makeEvent({ orderId: 'critical' });
    for (let i = 0; i < 4; i++) {
      await assert.rejects(handlePaymentEvent(critical, onPayment, silentLog));
    }
    assert.equal(
      _peekDispatchRetry(critical.id),
      4,
      'critical event counter should persist at 4 through 100 noise events',
    );
    // 5th attempt dead-letters.
    await handlePaymentEvent(critical, onPayment, silentLog);
    assert.ok(getDeadLetterRow(critical.txHash));
  });

  it('saturated map dead-letters NEW incoming events immediately', async () => {
    // Push the map to exactly DISPATCH_RETRY_CAP by running one
    // failing attempt per distinct eventId until full. 8192 is big
    // but manageable in a unit test.
    const onPayment = async () => {
      throw new Error('fill');
    };
    for (let i = 0; i < _DISPATCH_RETRY_CAP; i++) {
      await assert.rejects(
        handlePaymentEvent(makeEvent({ orderId: `fill-${i}` }), onPayment, silentLog),
      );
    }
    assert.equal(_getDispatchRetryMapSize(), _DISPATCH_RETRY_CAP);

    // One more NEW event should be dead-lettered immediately (on
    // first failure, not after 5) because the map is saturated.
    const overflowEvent = makeEvent({ orderId: 'overflow' });
    await handlePaymentEvent(overflowEvent, onPayment, silentLog);
    assert.ok(
      getDeadLetterRow(overflowEvent.txHash),
      'overflow event should be dead-lettered on first failure',
    );
    // Map size did NOT grow past the cap.
    assert.ok(_getDispatchRetryMapSize() <= _DISPATCH_RETRY_CAP);
  });

  it('existing entries continue to count normally during saturation', async () => {
    // Fill the map, then bump an existing entry — its counter must
    // still advance because it's not creating a new map slot.
    const onPayment = async () => {
      throw new Error('fill');
    };
    const sentinel = makeEvent({ orderId: 'sentinel' });
    // Sentinel gets counter=1 before saturation.
    await assert.rejects(handlePaymentEvent(sentinel, onPayment, silentLog));
    assert.equal(_peekDispatchRetry(sentinel.id), 1);

    for (let i = 0; i < _DISPATCH_RETRY_CAP - 1; i++) {
      await assert.rejects(
        handlePaymentEvent(makeEvent({ orderId: `fill-${i}` }), onPayment, silentLog),
      );
    }
    assert.equal(_getDispatchRetryMapSize(), _DISPATCH_RETRY_CAP);

    // Bumping the sentinel again must increment its counter, not be
    // treated as a new entry. 3 more attempts take it to 4.
    for (let i = 0; i < 3; i++) {
      await assert.rejects(handlePaymentEvent(sentinel, onPayment, silentLog));
    }
    assert.equal(_peekDispatchRetry(sentinel.id), 4);
    // 5th attempt dead-letters the sentinel normally.
    await handlePaymentEvent(sentinel, onPayment, silentLog);
    assert.ok(getDeadLetterRow(sentinel.txHash));
  });
});

// ── F2-stellar: dead-letter size cap ────────────────────────────────────────
//
// Pre-fix, serialiseEventForDeadLetter produced unbounded JSON output.
// A malformed event with a 10MB payload would write a 10MB row to
// stellar_dead_letter, amplifying a single adversarial event into
// significant storage cost and breaking the dead-letter table as a
// diffable forensic surface (ops can't grep through 10MB rows).
// Post-fix, output > 16KB is replaced with a {_truncated, _original_bytes,
// preview} marker that still captures the fact that something arrived
// and a short preview for pattern-matching in queries.

describe('F2-stellar: serialiseEventForDeadLetter size cap', () => {
  it('small events round-trip unchanged', () => {
    const event = {
      id: 'evt-1',
      ledger: 123,
      txHash: 'TXHASH1',
      topic: ['pay_usdc', 'order-abc'],
      value: 1_000_000n,
    };
    const out = _serialiseEventForDeadLetter(event);
    const parsed = JSON.parse(out);
    assert.equal(parsed.id, 'evt-1');
    assert.equal(parsed.ledger, 123);
    assert.equal(parsed.value, '1000000'); // BigInt → string
    assert.notEqual(parsed._truncated, true);
  });

  it('truncates events whose serialised form exceeds the cap', () => {
    const hugeBlob = 'x'.repeat(50_000);
    const event = {
      id: 'evt-big',
      ledger: 123,
      txHash: 'TXHASH_BIG',
      raw: hugeBlob,
    };
    const out = _serialiseEventForDeadLetter(event);
    const parsed = JSON.parse(out);
    assert.equal(parsed._truncated, true);
    assert.ok(parsed._original_bytes > 50_000);
    assert.ok(parsed.preview.length > 0);
    assert.ok(parsed.preview.length <= 512);
    // The output itself is bounded — not 50KB.
    assert.ok(out.length <= 1024, `truncated marker is small, got ${out.length}`);
  });

  it('dead-letter row stays bounded even for a hostile huge event', async () => {
    // End-to-end test: a parse-error path with a huge payload should
    // land in stellar_dead_letter with a truncated raw_event, not the
    // full multi-MB blob.
    const event = {
      id: 'evt-hostile',
      ledger: 999,
      txHash: 'TXHASH_HOSTILE',
      topic: [], // empty — triggers "topic.length < 3" early-return
      value: null,
      // Stuff a huge field into the event to blow up the serialised size.
      bigDiag: 'Y'.repeat(100_000),
    };
    // Won't reach dead-letter (topic.length < 3 is the silent-return
    // branch), so we exercise serialiseEventForDeadLetter directly.
    const serialised = _serialiseEventForDeadLetter(event);
    assert.ok(serialised.length <= _DEAD_LETTER_CAP_BYTES + 512);
    const parsed = JSON.parse(serialised);
    assert.equal(parsed._truncated, true);
  });

  it('serialisation failure still produces a labelled marker', () => {
    const circular = /** @type {any} */ ({ id: 'evt-cycle' });
    circular.self = circular;
    const out = _serialiseEventForDeadLetter(circular);
    assert.match(out, /serialisation_failed/);
  });
});

// Smoke check of the exported threshold constants so any future
// refactor that silently renames them fails loudly.
describe('F1-stellar: exported constants', () => {
  it('MAX_DISPATCH_RETRIES is at least 3', () => {
    assert.ok(_MAX_DISPATCH_RETRIES >= 3);
  });

  it('DISPATCH_RETRY_CAP is reasonable (not the old 1024 footgun)', () => {
    // Pre-fix the cap was 1024 — keep this as a regression guard so
    // anyone lowering it without understanding the F1 bug gets a
    // failing test.
    assert.ok(
      _DISPATCH_RETRY_CAP >= 4096,
      'cap must leave plenty of headroom for failure cascades',
    );
  });

  it('DEAD_LETTER_CAP_BYTES is at least 4KB', () => {
    assert.ok(_DEAD_LETTER_CAP_BYTES >= 4 * 1024);
  });
});
