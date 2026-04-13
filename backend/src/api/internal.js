// @ts-check
// Internal API — cards402 ops use only (admin.cards402.com)
// Protected by requireAuth + requireInternal (must be @cards402.com or in INTERNAL_EMAILS).
//
// Card data exposure is split (audit F4):
//   GET /internal/orders          — bulk list, NO PAN/CVV/expiry
//   GET /internal/orders/:id/card — single-order reveal, requires
//                                   requireCardReveal AND writes an
//                                   audit_log entry on every call.
// Before F4, the bulk list returned full PAN/CVV/expiry to any
// @cards402.com email — making every corporate inbox a potential card
// exfiltration vector.

const { Router } = require('express');
/** @type {any} */ const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireInternal = require('../middleware/requireInternal');
const requireCardReveal = require('../middleware/requireCardReveal');
const { scheduleRefund } = require('../fulfillment');
const { getOrderStats } = require('../lib/stats');

const router = Router();

router.use(requireAuth);
router.use(requireInternal);

// GET /internal/orders — all orders, NO raw card data.
// card_number/cvv/expiry are NOT returned here. Use /internal/orders/:id/card
// for an audited single-order reveal.
router.get('/orders', (req, res) => {
  const { status, limit = 100, api_key_id } = req.query;
  let query = `
    SELECT o.id, o.status, o.amount_usdc, o.payment_asset,
           o.stellar_txid, o.sender_address, o.refund_stellar_txid,
           o.card_brand,
           o.ctx_order_id, o.error, o.failure_count,
           o.created_at, o.updated_at,
           CASE WHEN o.card_number IS NOT NULL THEN 1 ELSE 0 END AS has_card,
           k.label AS api_key_label, k.id AS api_key_id
    FROM orders o
    LEFT JOIN api_keys k ON o.api_key_id = k.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    query += ` AND o.status = ?`;
    params.push(status);
  }
  if (api_key_id) {
    query += ` AND o.api_key_id = ?`;
    params.push(api_key_id);
  }
  query += ` ORDER BY o.created_at DESC LIMIT ?`;
  params.push(/** @type {any} */ (Math.min(parseInt(String(limit)) || 100, 1000)));
  res.json(db.prepare(query).all(...params));
});

// GET /internal/orders/:id/card — privileged single-order card reveal.
// Returns raw PAN/CVV/expiry. Every call writes an audit_log entry so
// reveal activity is reviewable. Gated by requireCardReveal in addition
// to the existing requireAuth + requireInternal stack.
router.get('/orders/:id/card', requireCardReveal, (req, res) => {
  const order = db
    .prepare(
      `SELECT id, card_number, card_cvv, card_expiry, card_brand, api_key_id
       FROM orders WHERE id = ?`,
    )
    .get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  if (!order.card_number) {
    return res.status(409).json({ error: 'no_card', message: 'Order has no card data' });
  }
  // F1: card columns are sealed at rest. openCard handles both sealed and
  // legacy plaintext rows transparently.
  const { openCard } = require('../lib/card-vault');
  const card = openCard(order);

  // Audit the reveal — actor, target, IP, UA. Resource_type = 'card_reveal'
  // makes filtering trivial in the audit log search later.
  try {
    const dashId =
      db.prepare(`SELECT dashboard_id FROM api_keys WHERE id = ?`).get(order.api_key_id)
        ?.dashboard_id || 'system';
    db.prepare(
      `INSERT INTO audit_log
         (dashboard_id, actor_user_id, actor_email, actor_role, action, resource_type, resource_id, details, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dashId,
      req.user.id || null,
      req.user.email,
      'internal_card_reveal',
      'order.card_reveal',
      'card_reveal',
      order.id,
      JSON.stringify({ api_key_id: order.api_key_id }),
      req.ip || null,
      req.headers['user-agent'] || null,
    );
  } catch (err) {
    // Don't let audit-log failure block the reveal — log to stderr instead.
    console.error(`[internal] audit log insert failed for card reveal: ${err.message}`);
  }

  res.json({
    order_id: order.id,
    card,
  });
});

// GET /internal/unmatched — on-chain payments that couldn't be matched to an order
router.get('/unmatched', (req, res) => {
  res.json(
    db
      .prepare(
        `
    SELECT id, stellar_txid, sender_address, payment_asset,
           amount_usdc, amount_xlm, claimed_order_id, reason,
           refund_stellar_txid, created_at
    FROM unmatched_payments
    ORDER BY created_at DESC
    LIMIT 200
  `,
      )
      .all(),
  );
});

// GET /internal/platform-wallet — platform Stellar wallet public key + Horizon balance
// Derives public key from STELLAR_XLM_SECRET; balance is fetched by the frontend from Horizon.
router.get('/platform-wallet', (req, res) => {
  try {
    const { Keypair } = require('@stellar/stellar-sdk');
    const secret = process.env.STELLAR_XLM_SECRET;
    if (!secret) return res.status(503).json({ error: 'STELLAR_XLM_SECRET not configured' });
    const keypair = Keypair.fromSecret(secret);
    res.json({ public_key: keypair.publicKey() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to derive platform wallet key', message: err.message });
  }
});

// GET /internal/stats — extended stats including refund_pending count and unmatched count.
// Audit A-18: uses shared getOrderStats() plus additional operator/unmatched counts.
router.get('/stats', (req, res) => {
  const totals = getOrderStats();
  const operators = db
    .prepare(`SELECT COUNT(*) AS total, SUM(enabled) AS active FROM api_keys`)
    .get();
  const unmatched = db
    .prepare(`SELECT COUNT(*) AS count FROM unmatched_payments WHERE refund_stellar_txid IS NULL`)
    .get();

  res.json({
    ...totals,
    total_operators: operators.total,
    active_operators: operators.active,
    unmatched_pending: unmatched.count,
  });
});

// POST /internal/orders/:id/refund — queue a manual refund (same as admin route)
router.post('/orders/:id/refund', async (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  try {
    await scheduleRefund(order.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'refund_failed', message: err.message });
  }
});

// GET /internal/operators — all API keys with full detail
router.get('/operators', (req, res) => {
  res.json(
    db
      .prepare(
        `
    SELECT id, label, spend_limit_usdc, total_spent_usdc,
           wallet_public_key, enabled, suspended, last_used_at, created_at,
           policy_daily_limit_usdc, policy_single_tx_limit_usdc,
           policy_require_approval_above_usdc
    FROM api_keys
    ORDER BY created_at DESC
  `,
      )
      .all(),
  );
});

module.exports = router;
