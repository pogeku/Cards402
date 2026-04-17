// @ts-check
// MPP router — unauthenticated endpoints for the Machine Payments
// Protocol. Mounted at /v1 BEFORE the auth middleware in app.js so
// anonymous agents can reach:
//
//   GET /v1/.well-known/mpp          → discovery
//   GET /v1/cards/visa/:amount       → 402 challenge (+ 200 on Phase 2 retry)
//   GET /v1/mpp/receipts/:id         → receipt polling for the 202 async path
//
// Phase 1 only serves the challenge shell: no credential verification
// and no card delivery. Phase 2 wires in verifyStellarPayment and the
// bounded-wait fulfillment handoff.

const { Router } = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { event: bizEvent } = require('../lib/logger');
const { openCard } = require('../lib/card-vault');
const { usdToXlm } = require('../payments/xlm-price');
const { createChallenge, loadChallenge, loadOrderByReceiptId } = require('./challenge');
const { buildDiscoveryDoc, buildChallengeBody, buildWwwAuthenticate } = require('./discovery');
const { verifyAndCreateMppOrder } = require('./verify');
const { waitForDelivery } = require('./wait-for-delivery');

// Per-IP rate limit on challenge creation. An unauthenticated endpoint
// must never be a free DoS amplifier — each GET creates a row in
// mpp_challenges, so we need a ceiling. 30/min/IP is plenty for a
// legitimate agent and cheap to enforce.
const challengeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: parseInt(process.env.MPP_CHALLENGE_RATE_LIMIT || '30', 10),
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      error: 'too_many_requests',
      message: 'MPP challenge rate limit exceeded. Retry in a minute.',
    }),
});

const AMOUNT_RE = /^\d+(?:\.\d{1,2})?$/;
const MIN_AMOUNT = 0.01;
const MAX_AMOUNT = 10_000.0;

/**
 * Build the router. Factored as a function so tests (and any future
 * isolation need) can construct it with custom deps.
 * @param {object} [opts]
 * @param {() => number} [opts.ttlMs] - Challenge TTL resolver (reads env at request time).
 */
function buildMppRouter(opts = {}) {
  const router = Router();
  const ttlMs = opts.ttlMs ?? (() => parseInt(process.env.MPP_CHALLENGE_TTL_MS || '600000', 10));

  // ── Discovery ─────────────────────────────────────────────────────────
  router.get('/.well-known/mpp', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(buildDiscoveryDoc());
  });

  // ── Challenge issuance ────────────────────────────────────────────────
  //
  // GET /v1/cards/visa/:amount returns 402 with the challenge. Phase 2
  // layers verification on top when Authorization: Payment is present.
  router.get('/cards/visa/:amount', challengeLimiter, async (req, res) => {
    const amountStr = String(req.params.amount || '');
    if (!AMOUNT_RE.test(amountStr)) {
      return res.status(400).json({
        error: 'invalid_amount',
        message: 'Amount must be a decimal like "10" or "10.00" with up to 2 decimal places.',
      });
    }
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      return res.status(400).json({
        error: 'amount_out_of_bounds',
        message: `Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} USDC.`,
      });
    }

    const resourcePath = `/v1/cards/visa/${amountStr}`;
    const amountUsdc = normaliseAmount(amountStr);

    // Credential present → verification + fulfillment path. The XLM
    // amount to verify against comes from the stored challenge row,
    // NOT a fresh usdToXlm() call, so price drift between challenge
    // issuance and retry doesn't cause spurious mismatches.
    if (req.headers.authorization && /^Payment\b/i.test(req.headers.authorization)) {
      const verdict = await verifyAndCreateMppOrder({
        authHeader: req.headers.authorization,
        resourcePath,
        expectedAmount: amountUsdc,
      });
      if (!verdict.ok) {
        const v = /** @type {any} */ (verdict);
        bizEvent('mpp.verify_rejected', {
          status: v.status,
          reason: v.reason,
        });
        return res.status(v.status).json({
          error: v.reason,
          ...(v.detail && { detail: v.detail }),
        });
      }
      return handleDeliveryForVerdict(req, res, verdict);
    }

    // No credential → issue a fresh 402 challenge. Quote XLM at issuance
    // time and snapshot it onto the challenge row; retry verification
    // uses the stored value so any subsequent price movement doesn't
    // make a paid tx look like an amount mismatch.
    let amountXlmQuote = null;
    try {
      const xlm = await usdToXlm(amountUsdc);
      if (xlm) amountXlmQuote = xlm;
    } catch (err) {
      bizEvent('mpp.xlm_quote_failed', { amount: amountUsdc, error: err?.message });
    }

    const challenge = createChallenge({
      resourcePath,
      amountUsdc,
      amountXlm: amountXlmQuote,
      clientIp: clientIpOf(req),
      ttlMs: ttlMs(),
    });

    const body = buildChallengeBody({ challenge, amountUsdc, amountXlmQuote });
    bizEvent('mpp.challenge_created', {
      challenge_id: challenge.id,
      amount: amountUsdc,
      client_ip: clientIpOf(req),
    });

    res.set('WWW-Authenticate', buildWwwAuthenticate(challenge.id));
    res.set('Cache-Control', 'no-store');
    return res.status(402).json(body);
  });

  // ── Receipt polling (202 → 200 transition) ────────────────────────────
  router.get('/mpp/receipts/:id', (req, res) => {
    const row = loadOrderByReceiptId(req.params.id);
    if (!row) {
      return res.status(404).json({
        error: 'receipt_not_found',
        message: 'No receipt matches this id. It may have expired or never existed.',
      });
    }
    if (row.status === 'delivered') {
      return res
        .status(200)
        .set('Payment-Receipt', buildPaymentReceiptHeader(row))
        .json({
          state: 'delivered',
          receipt_id: req.params.id,
          order_id: row.id,
          amount_usdc: row.amount_usdc,
          card: extractCardFields(row),
        });
    }
    if (row.status === 'failed') {
      return res.status(502).json({
        state: 'failed',
        receipt_id: req.params.id,
        order_id: row.id,
        message: 'Fulfillment failed. Funds are being refunded to the sender address.',
      });
    }
    return res.status(202).json({
      state: 'fulfilling',
      receipt_id: req.params.id,
      order_id: row.id,
      poll_url: `/v1/mpp/receipts/${req.params.id}`,
    });
  });

  return router;
}

// ── Delivery handoff ─────────────────────────────────────────────────
//
// After synchronous verification succeeds the order is created and
// handlePayment has dispatched. Wait up to MPP_SYNC_WAIT_MS for the
// order to reach 'delivered'; beyond that, hand off to a 202 + Location.
async function handleDeliveryForVerdict(req, res, verdict) {
  const syncWaitMs = parseInt(process.env.MPP_SYNC_WAIT_MS || '10000', 10);
  const result = await waitForDelivery({ orderId: verdict.orderId, timeoutMs: syncWaitMs });

  if (result.state === 'delivered') {
    res.set('Payment-Receipt', buildPaymentReceiptHeader(result.order));
    return res.status(200).json({
      state: 'delivered',
      receipt_id: verdict.receiptId,
      order_id: verdict.orderId,
      amount_usdc: result.order.amount_usdc,
      card: extractCardFields(result.order),
      challenge_id: verdict.challengeId,
      tx_hash: verdict.txHash,
    });
  }
  if (result.state === 'failed') {
    return res.status(502).json({
      state: 'failed',
      receipt_id: verdict.receiptId,
      order_id: verdict.orderId,
      message: 'Fulfillment failed. Funds are being refunded to the sender address.',
    });
  }
  // timeout — hand off to the receipt polling endpoint.
  const location = `/v1/mpp/receipts/${verdict.receiptId}`;
  res.set('Location', location);
  return res.status(202).json({
    state: 'fulfilling',
    receipt_id: verdict.receiptId,
    order_id: verdict.orderId,
    poll_url: location,
  });
}

function extractCardFields(row) {
  if (!row.card_number) return null;
  try {
    return openCard({
      number: row.card_number,
      cvv: row.card_cvv,
      expiry: row.card_expiry,
      brand: row.card_brand,
    });
  } catch {
    return {
      number: row.card_number,
      cvv: row.card_cvv,
      expiry: row.card_expiry,
      brand: row.card_brand,
    };
  }
}

function buildPaymentReceiptHeader(row) {
  const parts = [`challenge="${row.mpp_challenge_id ?? ''}"`];
  // stellar_txid column on orders stores the Stellar tx hash once
  // handlePayment marks the order paid. Fall back to empty if missing.
  if (row.stellar_txid) parts.push(`tx_hash="${row.stellar_txid}"`);
  parts.push(`settled_at="${new Date().toISOString()}"`);
  return parts.join(', ');
}

function clientIpOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip || null;
}

function normaliseAmount(s) {
  // '10' → '10.00'; '10.5' → '10.50'; '10.00' stays.
  if (!s.includes('.')) return `${s}.00`;
  const [whole, frac] = s.split('.');
  if (frac.length === 1) return `${whole}.${frac}0`;
  return s;
}

module.exports = { buildMppRouter, loadChallenge, normaliseAmount };
