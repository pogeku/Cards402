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
const { usdToXlm } = require('../payments/xlm-price');
const { createChallenge, loadChallenge, loadOrderByReceiptId } = require('./challenge');
const { buildDiscoveryDoc, buildChallengeBody, buildWwwAuthenticate } = require('./discovery');

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

    // If the client sent an Authorization: Payment credential, Phase 2
    // will verify it and return the card. In Phase 1 we reject credentials
    // with 501 so the wire contract is honest about capability.
    if (req.headers.authorization && /^Payment\b/i.test(req.headers.authorization)) {
      return res.status(501).json({
        error: 'not_implemented',
        message:
          'MPP credential verification is not enabled yet. Retry with the current 402 challenge when rollout completes.',
      });
    }

    const resourcePath = `/v1/cards/visa/${amountStr}`;
    const amountUsdc = normaliseAmount(amountStr);

    // XLM quote — same path as the classic orders API. A price-oracle
    // outage must not wedge the whole surface, so an XLM failure just
    // omits the XLM method from the challenge; the USDC method always
    // stands.
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
  //
  // Phase 1 stub: the receipt endpoint exists but always returns 404
  // since no challenges have been redeemed yet. Phase 2 fleshes out the
  // delivered / fulfilling states.
  router.get('/mpp/receipts/:id', (req, res) => {
    const row = loadOrderByReceiptId(req.params.id);
    if (!row) {
      return res.status(404).json({
        error: 'receipt_not_found',
        message: 'No receipt matches this id. It may have expired or never existed.',
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
