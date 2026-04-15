// @ts-check
// Agent-facing order API
// POST /orders      — create an order; VCC payment instructions are returned
// GET  /orders/:id  — poll order status (and retrieve card details when delivered)

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { isFrozen } = require('../fulfillment');
const { assertSafeUrl } = require('../lib/ssrf');
const { checkPolicy, recordDecision } = require('../policy');
const { usdToXlm } = require('../payments/xlm-price');
const { sendApprovalEmail, sendSpendAlertEmail } = require('../lib/email');
const { event: bizEvent } = require('../lib/logger');

const router = Router();

// Canonical JSON — stable serialisation of an arbitrary JSON-able value
// so that two semantically-identical inputs always produce the same
// string. Object keys are recursively sorted (lexicographic); arrays
// preserve order (arrays are ordered by definition); primitives are
// passed through to JSON.stringify. Used by the idempotency fingerprint
// so that a retry with a differently-iterated nested metadata object
// still hashes identically. Bounded recursion depth prevents a hostile
// body with a 10k-deep nested object from blowing the stack.
function canonicalJson(value, depth = 0) {
  if (depth > 32) {
    throw new Error('canonicalJson: nesting depth exceeds 32');
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // match JSON.stringify's own undefined-skip semantics
    parts.push(`${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

// Size caps on caller-supplied fields that end up persisted in the
// orders row. Without these, a hostile caller can bloat the DB by
// sending ~100KB metadata / webhook_url on every order request. Picks
// are generous enough for real clients: 8KB of serialised metadata is
// ~250 fields at 32-char values, and 2048 chars is the industry URL
// length ceiling (IE historical limit; modern servers accept more but
// nothing reasonable needs it).
const MAX_METADATA_JSON_BYTES = 8 * 1024;
const MAX_WEBHOOK_URL_CHARS = 2048;

// Rate limit order creation per API key — default 60/hour, overridable per key via rate_limit_rpm.
// req.apiKey is set by the auth middleware before this runs.
const orderCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req) => {
    const rpm = req.apiKey?.rate_limit_rpm;
    if (rpm && rpm > 0) return rpm * 60; // convert rpm → per-hour
    return 60; // default 60/hour
  },
  keyGenerator: (req) => req.apiKey?.id || /** @type {any} */ (ipKeyGenerator)(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'rate_limit_exceeded',
      message: "Too many orders created. Check your key's rate_limit_rpm setting.",
    }),
});

// Concurrent-stream tracking. Each open SSE connection on
// /v1/orders/:id/stream or /dashboard/stream increments the relevant
// bucket; the req.on('close') handler decrements. Two purposes:
//
//   1. Cap per-api-key concurrent streams so a hostile or buggy
//      agent can't open thousands of streams against their own
//      api key and pin ~5-10KB + two setInterval timers per
//      connection in memory.
//   2. Expose `openSSEStreamCount()` to /status so ops can see the
//      number of live SSE connections at any given moment. Without
//      this, an accidental stream leak is invisible until the
//      process starts growing RSS.
//
// Map lives at module scope so both /:id/stream (orders router) and
// /dashboard/stream (dashboard router) can share the same per-key
// ceiling and the same /status counter.
const MAX_STREAMS_PER_KEY = parseInt(process.env.MAX_SSE_STREAMS_PER_KEY || '20', 10);
const MAX_STREAMS_TOTAL = parseInt(process.env.MAX_SSE_STREAMS_TOTAL || '1000', 10);
const openStreamsByKey = new Map(); // api_key_id → count
let openStreamsTotal = 0;

function tryAcquireStreamSlot(apiKeyId) {
  if (openStreamsTotal >= MAX_STREAMS_TOTAL) {
    return { ok: false, reason: 'server_stream_limit' };
  }
  const current = openStreamsByKey.get(apiKeyId) || 0;
  if (current >= MAX_STREAMS_PER_KEY) {
    return { ok: false, reason: 'key_stream_limit' };
  }
  openStreamsByKey.set(apiKeyId, current + 1);
  openStreamsTotal += 1;
  return { ok: true };
}

function releaseStreamSlot(apiKeyId) {
  const current = openStreamsByKey.get(apiKeyId) || 0;
  if (current <= 1) openStreamsByKey.delete(apiKeyId);
  else openStreamsByKey.set(apiKeyId, current - 1);
  if (openStreamsTotal > 0) openStreamsTotal -= 1;
}

// Exported so /status + dashboard.js can read the same counters.
function openSSEStreamCount() {
  return { total: openStreamsTotal, unique_keys: openStreamsByKey.size };
}

// Rate limit status polling — 600/min per API key (10/s, generous but capped)
const orderPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  keyGenerator: (req) => req.apiKey?.id || /** @type {any} */ (ipKeyGenerator)(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'rate_limit_exceeded',
      message: 'Too many status polls. Slow down to at most 10 requests/second.',
    }),
});

// ── Policy preview (exported for use in app.js) ─────────────────────────────

function policyCheck(apiKeyId, amount) {
  // Preview mode: do NOT persist the decision to policy_decisions. The
  // preview endpoint (GET /v1/policy/check) is read-only from the user's
  // perspective and is rate-limited at 600/min — without this flag every
  // preview call would bloat policy_decisions with fake "decision" rows
  // that never corresponded to a real order and would also pollute the
  // post-incident forensic trail. See checkPolicy's persist option.
  const result = checkPolicy(apiKeyId, String(amount), { persist: false });
  const key = /** @type {any} */ (db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId));
  let remaining_daily = null;
  if (key?.policy_daily_limit_usdc) {
    const row = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
      FROM orders
      WHERE api_key_id = ? AND status NOT IN ('expired', 'rejected') AND date(created_at) = date('now')
    `,
        )
        .get(apiKeyId)
    );
    remaining_daily = Math.max(
      0,
      parseFloat(key.policy_daily_limit_usdc) - parseFloat(row.total),
    ).toFixed(2);
  }
  return { ...result, remaining_daily };
}

// ── Budget helper (exported for use in /v1/usage) ─────────────────────────────

function buildBudget(apiKey) {
  const spent = parseFloat(apiKey.total_spent_usdc || '0');
  const limit = apiKey.spend_limit_usdc ? parseFloat(apiKey.spend_limit_usdc) : null;
  return {
    spent_usdc: spent.toFixed(2),
    limit_usdc: limit !== null ? limit.toFixed(2) : null,
    remaining_usdc: limit !== null ? Math.max(0, limit - spent).toFixed(2) : null,
  };
}

// POST /orders — create order, dispatch to VCC, return payment instructions
// Supports Idempotency-Key header: same key within 24h returns the original response.
//
// Concurrency model: the DB write path runs inside a single synchronous
// better-sqlite3 transaction (db.transaction). SQLite opens writes with
// BEGIN IMMEDIATE, which acquires an exclusive write lock for the whole
// txn — so two concurrent POST /orders on the same api_key serialise on
// the lock, and the second request sees the first one's committed state
// when it reads in-flight totals and the daily policy budget.
//
// This closes three TOCTOU races the adversarial audit found:
//
//   1. spend_limit_usdc — SELECT sum of in-flight + settled, compare to
//      limit, INSERT new row. Previously a gap between the SELECT and
//      the INSERT let two concurrent requests both pass the check.
//   2. policy_daily_limit_usdc — same shape, inside checkPolicy().
//   3. Idempotency-Key replay — SELECT cached row, INSERT OR IGNORE
//      after doing the work. Two concurrent requests with the same
//      key both saw "no cache", both did the work, both wrote orphan
//      order rows.
//
// All async work (assertSafeUrl, usdToXlm) happens BEFORE the txn; the
// txn is pure DB reads + writes so it can stay synchronous. Side-effect
// notifications (approval email / Discord ping / spend-alert email)
// fire AFTER commit out-of-band.
router.post('/', orderCreateLimiter, async (req, res) => {
  // Idempotency-Key handling — hardening from the adversarial audit:
  //
  // F2: express parses repeated headers into an array. The previous
  // code used `req.headers['idempotency-key']` directly, which would
  // stringify `['a','b']` into the DB on a duplicated header. Reject
  // the duplicate with 400 so the caller can't accidentally persist
  // junk keys. Also cap the key length at 255 chars — long keys bloat
  // the idempotency_keys table indefinitely (every retry writes a new
  // row) and no real client needs more than that.
  const rawIdemHeader = req.headers['idempotency-key'];
  if (Array.isArray(rawIdemHeader)) {
    return res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Idempotency-Key header may appear at most once.',
    });
  }
  const idempotencyKey = typeof rawIdemHeader === 'string' ? rawIdemHeader : null;
  if (idempotencyKey && idempotencyKey.length > 255) {
    return res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Idempotency-Key must be at most 255 characters.',
    });
  }

  // F1: canonical JSON stringify for the fingerprint. The previous
  // implementation passed `Object.keys(body).sort()` as JSON.stringify's
  // replacer, which only restricts top-level key order — nested objects
  // still serialise in whatever iteration order their reference client
  // happened to produce. Two semantically-identical retries from
  // different clients would therefore produce different fingerprints
  // and spuriously 409 on retry. Recursively sorting every object's
  // keys before stringify is the deterministic fix.
  const requestFingerprint = idempotencyKey
    ? crypto.createHash('sha256').update(canonicalJson(req.body)).digest('hex')
    : null;

  if (isFrozen()) {
    return res.status(503).json({
      error: 'service_temporarily_unavailable',
      message: 'Card fulfillment is temporarily suspended. Please try again later.',
    });
  }

  const { amount_usdc, webhook_url, metadata } = req.body;

  // Strict decimal validation — reject "10abc" which parseFloat would
  // silently accept as 10, AND reject sub-cent amounts like "10.12345"
  // which Pathward cannot represent (every Visa Reward Card balance is
  // integer cents). The previous regex was `/^\d+(\.\d+)?$/` which
  // allowed any decimal precision; a caller sending amount_usdc:
  // "10.12345678" would slip past validation, get parseFloat'd, and
  // land in the spend-limit accounting with sub-cent precision the
  // rest of the pipeline can't honour. Tighten to max 2 decimals so
  // every stored amount_usdc is integer-cents-clean.
  if (typeof amount_usdc !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount_usdc.trim())) {
    return res.status(400).json({
      error: 'invalid_amount',
      message: 'amount_usdc must be a decimal with at most 2 decimal places (e.g. "10.00")',
    });
  }
  const amount = parseFloat(amount_usdc);
  if (!amount || amount <= 0) {
    return res
      .status(400)
      .json({ error: 'invalid_amount', message: 'amount_usdc must be a positive number' });
  }
  // Platform order bounds. Min is $0.01 (smallest USD value the issuer
  // can represent on a gift card); max is $10,000 (Pathward's absolute
  // ceiling on a single prepaid card balance). Agents that need more
  // should issue multiple cards — blast-radius containment is a
  // feature, not a bug.
  if (amount < 0.01) {
    return res
      .status(400)
      .json({ error: 'invalid_amount', message: 'amount_usdc must be at least $0.01' });
  }
  if (amount > 10000) {
    return res
      .status(400)
      .json({ error: 'invalid_amount', message: 'amount_usdc cannot exceed $10000.00' });
  }

  // Validate webhook_url upfront — fail fast rather than storing a bad URL.
  // F4: cap the URL length before SSRF validation so a 100KB url can't
  // be used to bloat the orders.webhook_url column across many orders.
  if (webhook_url !== undefined && webhook_url !== null) {
    if (typeof webhook_url !== 'string') {
      return res.status(400).json({
        error: 'invalid_webhook_url',
        message: 'webhook_url must be a string',
      });
    }
    if (webhook_url.length > MAX_WEBHOOK_URL_CHARS) {
      return res.status(400).json({
        error: 'invalid_webhook_url',
        message: `webhook_url must be at most ${MAX_WEBHOOK_URL_CHARS} characters`,
      });
    }
    if (webhook_url) {
      try {
        await assertSafeUrl(webhook_url);
      } catch (err) {
        return res.status(400).json({ error: 'invalid_webhook_url', message: err.message });
      }
    }
  }

  // Validate metadata — must be a plain JSON object if provided.
  // F3: cap the serialised size to keep orders.metadata from being
  // abused as a free-form blob column. 8KB is far beyond anything a
  // real client needs (a few hundred key/value pairs) while still
  // cheap to store and transit.
  let metadataStr = null;
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return res
        .status(400)
        .json({ error: 'invalid_metadata', message: 'metadata must be a JSON object' });
    }
    try {
      metadataStr = JSON.stringify(metadata);
    } catch {
      return res
        .status(400)
        .json({ error: 'invalid_metadata', message: 'metadata could not be serialized' });
    }
    if (Buffer.byteLength(metadataStr, 'utf8') > MAX_METADATA_JSON_BYTES) {
      return res.status(400).json({
        error: 'invalid_metadata',
        message: `metadata serialized size must be at most ${MAX_METADATA_JSON_BYTES} bytes`,
      });
    }
  }

  // ── Async pre-work (must happen BEFORE the db.transaction) ─────────────────
  // usdToXlm is a Horizon fetch; we resolve it up-front and then let
  // the synchronous transaction below decide what to do with the
  // result. If the price oracle is down we simply don't advertise an
  // XLM payment branch for this order.
  let xlmAmount = null;
  try {
    xlmAmount = await usdToXlm(String(amount));
  } catch (err) {
    console.warn(`[orders] XLM price lookup failed: ${err.message}`);
  }

  // Stable USDC issuer for the Soroban payment envelope.
  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  // ── Atomic DB work — closes the spend/policy/idempotency TOCTOUs ───────────
  //
  // Returns a discriminated union so all post-commit branching lives
  // outside the transaction. Anything that needs to be retried without
  // holding the write lock (HTTP response, outbound notifications,
  // spend-alert emails) runs AFTER the transaction commits.
  const txnResult = db.transaction(() => {
    // Re-check the idempotency cache inside the txn. If another
    // concurrent request finished and wrote the cache while we were
    // waiting on the BEGIN IMMEDIATE lock, we see their response here
    // and return it without double-creating an order.
    if (idempotencyKey) {
      const cached = /** @type {any} */ (
        db
          .prepare(
            `SELECT response_status, response_body, request_fingerprint
             FROM idempotency_keys WHERE key = ? AND api_key_id = ?`,
          )
          .get(idempotencyKey, req.apiKey.id)
      );
      if (cached) {
        if (cached.request_fingerprint && cached.request_fingerprint !== requestFingerprint) {
          return { kind: 'idem_conflict' };
        }
        return {
          kind: 'idem_hit',
          status: cached.response_status,
          body: JSON.parse(cached.response_body),
        };
      }
    }

    // Spend-limit check. SELECT + INSERT are now both inside the
    // same txn, so concurrent writers see each other's in-flight
    // totals.
    //
    // Adversarial audit F1-approval: 'awaiting_approval' MUST be in
    // the in-flight status list. Without it, an agent past their
    // approval threshold can submit N orders whose combined amount
    // exceeds spend_limit — each order's spend check sees zero
    // in-flight (because every prior submission is sitting in
    // awaiting_approval) and passes. When the owner sequentially
    // approves, the spend limit is quietly breached. The daily_limit
    // query in policy.js already counts awaiting_approval via its
    // `status NOT IN ('expired','rejected')` filter; the two
    // enforcement paths were just inconsistent. Rejected awaiting-
    // approval rows flip to 'rejected' and correctly drop out of the
    // sum.
    if (req.apiKey.spend_limit_usdc) {
      const settled = parseFloat(req.apiKey.total_spent_usdc || '0');
      const inFlightRow = /** @type {any} */ (
        db
          .prepare(
            `SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
             FROM orders
             WHERE api_key_id = ?
               AND status IN ('pending_payment','ordering','refund_pending','awaiting_approval')`,
          )
          .get(req.apiKey.id)
      );
      const inFlight = inFlightRow ? parseFloat(inFlightRow.total) : 0;
      const limit = parseFloat(req.apiKey.spend_limit_usdc);
      if (settled + inFlight + amount > limit) {
        return {
          kind: 'spend_limit_exceeded',
          limit: req.apiKey.spend_limit_usdc,
          spent: req.apiKey.total_spent_usdc,
        };
      }
    }

    // Policy engine — its daily_limit query is now ALSO inside the txn,
    // so daily_limit can't be breached by concurrent POSTs either.
    const policyResult = checkPolicy(req.apiKey.id, amount_usdc);
    if (policyResult.decision === 'blocked') {
      return {
        kind: 'policy_blocked',
        rule: policyResult.rule,
        message: policyResult.reason,
      };
    }

    const id = uuidv4();

    // Approval required branch.
    if (policyResult.decision === 'pending_approval') {
      db.prepare(
        `INSERT INTO orders (id, status, amount_usdc, api_key_id, webhook_url, request_id)
         VALUES (@id, 'awaiting_approval', @amount_usdc, @api_key_id, @webhook_url, @request_id)`,
      ).run({
        id,
        amount_usdc: String(amount),
        api_key_id: req.apiKey.id,
        webhook_url: webhook_url || null,
        request_id: req.id || null,
      });

      const approvalId = uuidv4();
      // Configurable approval TTL. Default 2 hours.
      const approvalTtlMs =
        Math.max(5, parseInt(process.env.APPROVAL_TTL_MINUTES || '120', 10)) * 60 * 1000;
      const expiresAt = new Date(Date.now() + approvalTtlMs).toISOString();
      db.prepare(
        `INSERT INTO approval_requests (id, api_key_id, order_id, amount_usdc, agent_note, expires_at)
         VALUES (@id, @api_key_id, @order_id, @amount_usdc, @agent_note, @expires_at)`,
      ).run({
        id: approvalId,
        api_key_id: req.apiKey.id,
        order_id: id,
        amount_usdc: String(amount),
        agent_note:
          typeof req.body.note === 'string' && req.body.note.length > 0
            ? req.body.note.slice(0, 1000)
            : null,
        expires_at: expiresAt,
      });

      recordDecision(
        req.apiKey.id,
        id,
        String(amount),
        'pending_approval',
        policyResult.rule,
        policyResult.reason,
      );

      const approvalBody = {
        order_id: id,
        phase: 'awaiting_approval',
        approval_request_id: approvalId,
        amount_usdc: String(amount),
        message: policyResult.reason,
        note: `The account owner has been notified. Poll GET /v1/orders/${id} to check status.`,
        expires_at: expiresAt,
      };

      if (idempotencyKey) {
        db.prepare(
          `INSERT OR IGNORE INTO idempotency_keys
           (key, api_key_id, request_fingerprint, response_status, response_body)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(idempotencyKey, req.apiKey.id, requestFingerprint, 202, JSON.stringify(approvalBody));
      }

      return {
        kind: 'approval',
        status: 202,
        body: approvalBody,
        approvalId,
        id,
        reason: policyResult.reason,
      };
    }

    // Sandbox mode — insert 'delivered' row with sealed fake card.
    if (req.apiKey.mode === 'sandbox') {
      const { sealCard } = require('../lib/card-vault');
      const sealed = sealCard({
        number: '4111111111111111',
        cvv: '123',
        expiry: '12/99',
        brand: 'Visa',
      });
      db.prepare(
        `INSERT INTO orders (id, status, amount_usdc, api_key_id, webhook_url, metadata, request_id,
                             card_number, card_cvv, card_expiry, card_brand)
         VALUES (@id, 'delivered', @amount_usdc, @api_key_id, @webhook_url, @metadata, @request_id,
                 @num, @cvv, @expiry, @brand)`,
      ).run({
        id,
        amount_usdc: String(amount),
        api_key_id: req.apiKey.id,
        webhook_url: webhook_url || null,
        metadata: metadataStr,
        request_id: req.id || null,
        num: sealed.number,
        cvv: sealed.cvv,
        expiry: sealed.expiry,
        brand: sealed.brand,
      });
      const sandboxBody = {
        order_id: id,
        status: 'delivered',
        phase: 'ready',
        amount_usdc: String(amount),
        sandbox: true,
        card: { number: '4111111111111111', cvv: '123', expiry: '12/99', brand: 'Visa' },
      };
      if (idempotencyKey) {
        db.prepare(
          `INSERT OR IGNORE INTO idempotency_keys
           (key, api_key_id, request_fingerprint, response_status, response_body)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(idempotencyKey, req.apiKey.id, requestFingerprint, 201, JSON.stringify(sandboxBody));
      }
      return { kind: 'order', status: 201, body: sandboxBody };
    }

    // Real mode — real Soroban contract payment instructions.
    const contractPayment = {
      type: 'soroban_contract',
      contract_id: process.env.RECEIVER_CONTRACT_ID,
      order_id: id,
      usdc: { amount: String(amount), asset: `USDC:${USDC_ISSUER}` },
      ...(xlmAmount && { xlm: { amount: xlmAmount } }),
    };
    db.prepare(
      `INSERT INTO orders (id, status, amount_usdc, expected_xlm_amount, api_key_id,
                           webhook_url, metadata, vcc_payment_json, request_id)
       VALUES (@id, 'pending_payment', @amount_usdc, @expected_xlm_amount, @api_key_id,
               @webhook_url, @metadata, @vcc_payment_json, @request_id)`,
    ).run({
      id,
      amount_usdc: String(amount),
      expected_xlm_amount: xlmAmount || null,
      api_key_id: req.apiKey.id,
      webhook_url: webhook_url || null,
      metadata: metadataStr,
      vcc_payment_json: JSON.stringify(contractPayment),
      request_id: req.id || null,
    });
    const freshKey = /** @type {any} */ (
      db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(req.apiKey.id)
    );
    const budget = buildBudget(freshKey);
    const responseBody = {
      order_id: id,
      status: 'pending_payment',
      phase: 'awaiting_payment',
      amount_usdc: String(amount),
      payment: contractPayment,
      poll_url: `/v1/orders/${id}`,
      budget,
    };
    if (idempotencyKey) {
      db.prepare(
        `INSERT OR IGNORE INTO idempotency_keys
         (key, api_key_id, request_fingerprint, response_status, response_body)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, req.apiKey.id, requestFingerprint, 201, JSON.stringify(responseBody));
    }
    return { kind: 'order', status: 201, body: responseBody };
  })();

  // ── Post-commit dispatch ────────────────────────────────────────────────────
  switch (txnResult.kind) {
    case 'idem_conflict':
      bizEvent('idempotency.conflict', {
        api_key_id: req.apiKey.id,
        idempotency_key: idempotencyKey.slice(0, 16),
      });
      return res.status(409).json({
        error: 'idempotency_conflict',
        message: 'Idempotency-Key reused with a different request body.',
      });
    case 'idem_hit':
      bizEvent('idempotency.cache_hit', {
        api_key_id: req.apiKey.id,
        idempotency_key: idempotencyKey.slice(0, 16),
        cached_status: txnResult.status,
      });
      return res.status(txnResult.status).json(txnResult.body);
    case 'spend_limit_exceeded':
      return res.status(403).json({
        error: 'spend_limit_exceeded',
        limit: txnResult.limit,
        spent: txnResult.spent,
      });
    case 'policy_blocked':
      return res.status(403).json({
        error: 'policy_blocked',
        rule: txnResult.rule,
        message: txnResult.message,
      });
    case 'approval':
      // Fire the owner notification AFTER commit so the email/Discord
      // ping doesn't hold the write lock on slow SMTP.
      notifyOwnerApprovalNeeded({
        approvalId: txnResult.approvalId,
        orderId: txnResult.id,
        amountUsdc: amount_usdc,
        apiKeyId: req.apiKey.id,
        keyLabel: req.apiKey.label,
        reason: txnResult.reason,
      });
      return res.status(txnResult.status).json(txnResult.body);
    case 'order':
      // Spend alert — notify owner if key is near daily or total limit.
      checkSpendAlert(req.apiKey.id, amount).catch(() => {});
      return res.status(txnResult.status).json(txnResult.body);
    default:
      // Exhaustiveness check — should never hit.
      return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /orders — list agent's own orders.
// Audit A-19: supports `since_created_at` / `since_updated_at` ISO-8601
// timestamps so agents can poll for new orders without re-fetching the
// whole history, plus `offset` for simple pagination and a tighter hard
// cap on `limit` (200 from the previous 100 to support larger polling
// windows without exceeding DB response size).
router.get('/', orderPollLimiter, (req, res) => {
  const { status, limit = 20, offset = 0, since_created_at, since_updated_at } = req.query;
  let query = `SELECT id, status, amount_usdc, payment_asset, created_at, updated_at FROM orders WHERE api_key_id = ?`;
  const params = [req.apiKey.id];
  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }
  if (since_created_at) {
    query += ` AND created_at >= ?`;
    params.push(String(since_created_at));
  }
  if (since_updated_at) {
    query += ` AND updated_at >= ?`;
    params.push(String(since_updated_at));
  }
  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(parseInt(String(limit)) || 20, 200));
  params.push(Math.max(parseInt(String(offset)) || 0, 0));
  res.json(db.prepare(query).all(...params));
});

// Map internal pipeline statuses → stable agent-facing phase
const PHASE = {
  awaiting_approval: 'awaiting_approval',
  pending_payment: 'awaiting_payment',
  expired: 'expired',
  rejected: 'rejected',
  ordering: 'processing',
  delivered: 'ready',
  failed: 'failed',
  refund_pending: 'failed',
  refunded: 'refunded',
};

// Build the public-facing payload for an order row. Shared by GET /:id and
// GET /:id/stream so both return exactly the same shape.
function buildOrderResponse(order) {
  const response = {
    order_id: order.id,
    status: order.status,
    phase: PHASE[order.status] ?? 'processing',
    amount_usdc: order.amount_usdc,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };

  if (order.status === 'awaiting_approval') {
    const approval = /** @type {any} */ (
      db
        .prepare(`SELECT id, expires_at, status FROM approval_requests WHERE order_id = ?`)
        .get(order.id)
    );
    response.approval_request_id = approval?.id ?? null;
    response.note = 'Awaiting owner approval. The account owner has been notified.';
    response.expires_at = approval?.expires_at ?? null;
  }

  if (order.status === 'pending_payment' && order.vcc_payment_json) {
    try {
      response.payment = JSON.parse(order.vcc_payment_json);
    } catch {
      /* malformed JSON — omit payment */
    }
  }

  if (order.status === 'delivered') {
    // F1: card_number/cvv/expiry are sealed at rest. openCard pass-throughs
    // plaintext rows during the upgrade window so legacy orders still work.
    const { openCard } = require('../lib/card-vault');
    const { normalizeCardBrand } = require('../lib/normalize-card');
    const card = openCard(order);
    if (card) {
      // Replace the raw upstream brand (e.g. "Visa® Reward Card, 6-Month
      // Expiration [ITNL] eGift Card") with a stable agent-facing label
      // before sending to the agent. The raw brand stays in the DB row
      // for ops/audit but never reaches the agent transcript.
      card.brand = normalizeCardBrand(card.brand);
    }
    response.card = card;
  }

  if (order.status === 'expired') {
    response.note = 'Payment window expired. No funds were taken.';
  }

  if (order.status === 'rejected') {
    response.error = order.error ?? 'rejected_by_owner';
    response.note = 'This transaction was rejected. No funds were taken.';
  }

  if (['failed', 'refund_pending', 'refunded'].includes(order.status)) {
    response.error = order.error;
    if (order.status === 'refunded') {
      response.refund = { stellar_txid: order.refund_stellar_txid };
    }
  }

  if (order.metadata) {
    try {
      response.metadata = JSON.parse(order.metadata);
    } catch {
      /* skip malformed */
    }
  }

  return response;
}

const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'refunded', 'expired', 'rejected']);

// GET /orders/:id/stream — SSE stream of phase transitions.
//
// Replaces HTTP polling for long-lived agents: one open connection gets
// pushed every state change until the order reaches a terminal phase, at
// which point the server closes the stream. Internal implementation is a
// 500ms SQLite tick per connection (cheap at our current scale; swap for an
// in-process EventEmitter later if fanout grows).
//
// Client protocol (standard SSE):
//   event: phase
//   id: <ms-since-epoch of updated_at>
//   data: <same JSON body as GET /orders/:id>
//
// Reconnection: each event carries the full current state, so a client can
// reopen the stream at any time and rebuild its view from the first event
// without needing Last-Event-ID replay.
router.get('/:id/stream', (req, res) => {
  const orderId = req.params.id;
  const keyId = req.apiKey.id;

  const initial = /** @type {any} */ (
    db.prepare(`SELECT * FROM orders WHERE id = ? AND api_key_id = ?`).get(orderId, keyId)
  );
  if (!initial) {
    return res.status(404).json({ error: 'order_not_found' });
  }

  // Acquire a concurrent-stream slot before flushing headers. If the
  // api key is at its MAX_STREAMS_PER_KEY ceiling or the backend is at
  // its global MAX_STREAMS_TOTAL, reject with 429 so the agent backs
  // off. A legitimate SDK opens exactly one stream per outstanding
  // order; hitting this limit means the agent is leaking streams or
  // trying a DoS.
  const slot = tryAcquireStreamSlot(keyId);
  if (!slot.ok) {
    return res.status(429).json({
      error: 'too_many_streams',
      reason: slot.reason,
      message:
        'This api key has too many concurrent SSE streams open. Close some before opening more.',
    });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx to pass bytes straight through
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  let lastUpdated = '';
  let closed = false;

  function emit(row) {
    const payload = buildOrderResponse(row);
    const id = Date.parse(row.updated_at) || Date.now();
    res.write(`id: ${id}\nevent: phase\ndata: ${JSON.stringify(payload)}\n\n`);
    return TERMINAL_STATUSES.has(row.status);
  }

  // Initial state — so reconnects always see current phase on first message.
  lastUpdated = initial.updated_at;
  if (emit(initial)) {
    releaseStreamSlot(keyId);
    res.end();
    return;
  }

  // Close-and-cleanup helper. Single source of truth for stream
  // teardown — both the terminal-state branch inside the tick, the
  // req.on('close') handler, and any error path inside the interval
  // callbacks route through here. Idempotent via the `closed` flag
  // so a double-call (e.g., tick hits terminal and then req.on('close')
  // fires right after) doesn't under-count the per-key slot total.
  //
  // res.end() is safe to call on an already-closed response: Node's
  // HTTP module treats it as a no-op / ERR_STREAM_WRITE_AFTER_END
  // (non-fatal) so we can invoke it unconditionally.
  function closeStream() {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    clearInterval(keepalive);
    releaseStreamSlot(keyId);
    try {
      res.end();
    } catch {
      /* socket already dead */
    }
  }

  // F1-sse-stream: wrap the tick in try/catch. Previously a SQLite
  // throw (transient lock, disk error, corrupt row) or a res.write()
  // throw (socket closed before Node emits the 'close' event — e.g.,
  // abrupt TCP reset) escaped the setInterval callback as an
  // uncaught exception, landed in the index.js global handler, and
  // kicked a graceful shutdown — taking the whole process down from
  // a single bad row or racy disconnect. Now we log the error to
  // stderr, close just this stream, and let the other ~999
  // concurrent streams and every background job keep running.
  const tick = setInterval(() => {
    if (closed) return;
    try {
      const row = /** @type {any} */ (
        db.prepare(`SELECT * FROM orders WHERE id = ? AND api_key_id = ?`).get(orderId, keyId)
      );
      if (!row) {
        closeStream();
        return;
      }
      if (row.updated_at !== lastUpdated) {
        lastUpdated = row.updated_at;
        if (emit(row)) closeStream();
      }
    } catch (err) {
      console.error(
        `[orders.stream] tick error for ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      closeStream();
    }
  }, 500);

  // SSE comment ping every 15s so intermediate proxies don't idle-kill.
  // Same catch-and-close discipline as the tick — a dead socket can
  // surface as a res.write() throw between Node's 'close' event and
  // our handler running. Don't take the process down for it.
  const keepalive = setInterval(() => {
    if (closed) return;
    try {
      res.write(': keepalive\n\n');
    } catch (err) {
      console.error(
        `[orders.stream] keepalive error for ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      closeStream();
    }
  }, 15000);

  // F2-sse-stream: the close handler now delegates to closeStream()
  // instead of duplicating its cleanup logic. Any future cleanup
  // step added to closeStream is automatically picked up by the
  // disconnect path.
  req.on('close', () => {
    closeStream();
  });
});

// GET /orders/:id — poll status, returns card details when delivered
router.get('/:id', orderPollLimiter, (req, res) => {
  const order = /** @type {any} */ (
    db
      .prepare(`SELECT * FROM orders WHERE id = ? AND api_key_id = ?`)
      .get(req.params.id, req.apiKey.id)
  );
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  res.json(buildOrderResponse(order));
});

// Notify owner via Discord + email when an approval is needed
async function notifyOwnerApprovalNeeded({
  approvalId,
  orderId,
  amountUsdc,
  apiKeyId,
  keyLabel,
  reason,
}) {
  const label = keyLabel ? `"${keyLabel}"` : apiKeyId.slice(0, 8);

  // Discord
  const discordUrl = process.env.DISCORD_WEBHOOK_OWNER;
  if (discordUrl) {
    fetch(discordUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            title: `⏳ Approval required — $${amountUsdc}`,
            description: reason,
            color: 0xfbbf24,
            fields: [
              { name: 'Agent', value: label, inline: true },
              { name: 'Amount', value: `$${amountUsdc} USDC`, inline: true },
              { name: 'Order', value: orderId.slice(0, 8), inline: true },
            ],
            footer: { text: `Approval ID: ${approvalId} · Expires in 2h` },
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }

  // Email to owner
  try {
    const ownerRow = /** @type {any} */ (
      db.prepare(`SELECT email FROM users WHERE role = 'owner' LIMIT 1`).get()
    );
    if (ownerRow?.email) {
      await sendApprovalEmail(ownerRow.email, {
        approvalId,
        orderId,
        amountUsdc,
        keyLabel: label,
        reason,
      });
    }
  } catch {
    /* non-critical */
  }
}

// Fire-and-forget spend alert when an order is placed.
// Alerts at 80% and 90% of daily and total limits.
// Uses system_state to debounce — only alerts once per threshold crossing.
async function checkSpendAlert(apiKeyId, newAmount) {
  const key = /** @type {any} */ (db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(apiKeyId));
  if (!key) return;
  const ownerRow = /** @type {any} */ (
    db.prepare(`SELECT email FROM users WHERE role = 'owner' LIMIT 1`).get()
  );
  if (!ownerRow?.email) return;

  const label = key.label || apiKeyId.slice(0, 8);
  const THRESHOLDS = [80, 90, 100];

  // Total spend limit
  if (key.spend_limit_usdc) {
    const limit = parseFloat(key.spend_limit_usdc);
    const spent = parseFloat(key.total_spent_usdc || '0') + parseFloat(newAmount);
    const pct = Math.floor((spent / limit) * 100);
    for (const threshold of THRESHOLDS) {
      if (pct >= threshold) {
        const alertKey = `spend_alert:${apiKeyId}:total:${threshold}`;
        const already = db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(alertKey);
        if (!already) {
          db.prepare(`INSERT OR IGNORE INTO system_state (key, value) VALUES (?, '1')`).run(
            alertKey,
          );
          sendSpendAlertEmail(ownerRow.email, {
            keyLabel: label,
            pct: threshold,
            spentUsdc: spent.toFixed(2),
            limitUsdc: key.spend_limit_usdc,
            limitType: 'total',
          }).catch(() => {});
        }
        break;
      }
    }
  }

  // Daily limit
  if (key.policy_daily_limit_usdc) {
    const limit = parseFloat(key.policy_daily_limit_usdc);
    const row = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total
      FROM orders
      WHERE api_key_id = ? AND status NOT IN ('expired', 'rejected') AND date(created_at) = date('now')
    `,
        )
        .get(apiKeyId)
    );
    const spentToday = parseFloat(row.total) + parseFloat(newAmount);
    const pct = Math.floor((spentToday / limit) * 100);
    const today = new Date().toISOString().slice(0, 10);
    for (const threshold of THRESHOLDS) {
      if (pct >= threshold) {
        const alertKey = `spend_alert:${apiKeyId}:daily:${threshold}:${today}`;
        const already = db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(alertKey);
        if (!already) {
          db.prepare(`INSERT OR IGNORE INTO system_state (key, value) VALUES (?, '1')`).run(
            alertKey,
          );
          sendSpendAlertEmail(ownerRow.email, {
            keyLabel: label,
            pct: threshold,
            spentUsdc: spentToday.toFixed(2),
            limitUsdc: key.policy_daily_limit_usdc,
            limitType: 'daily',
          }).catch(() => {});
        }
        break;
      }
    }
  }
}

module.exports = router;
module.exports.buildBudget = buildBudget;
module.exports.policyCheck = policyCheck;
module.exports.openSSEStreamCount = openSSEStreamCount;
module.exports.tryAcquireStreamSlot = tryAcquireStreamSlot;
module.exports.releaseStreamSlot = releaseStreamSlot;
// Exported so app.js can reuse the same per-key bucket on the small
// read endpoints it still owns (/v1/policy/check, /v1/usage). Keeping
// a single limiter for "agent reads" means one noisy key can't steal
// its own poll budget by spamming preview endpoints.
module.exports.orderPollLimiter = orderPollLimiter;
