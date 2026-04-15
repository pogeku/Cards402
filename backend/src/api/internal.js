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
const { recordAudit } = require('../lib/audit');
// scheduleRefund import removed along with the manual refund endpoint — see below
const { getOrderStats } = require('../lib/stats');

const router = Router();

router.use(requireAuth);
router.use(requireInternal);

// GET /internal/orders — all orders, NO raw card data.
// card_number/cvv/expiry are NOT returned here. Use /internal/orders/:id/card
// for an audited single-order reveal.
router.get('/orders', (req, res) => {
  const { status, limit = 100, api_key_id } = req.query;

  // F3-internal adversarial audit (2026-04-15): reject non-string
  // query params instead of letting them reach the SQLite bind layer.
  // `?status=a&status=b` parses into an array which better-sqlite3
  // rejects at bind time with an opaque 500. Clear 400 keeps ops
  // tooling out of the unknown-error bucket.
  if (status !== undefined && typeof status !== 'string') {
    return res.status(400).json({
      error: 'invalid_query_param',
      message: 'status must be a single string (no repeated ?status=... params).',
    });
  }
  if (api_key_id !== undefined && typeof api_key_id !== 'string') {
    return res.status(400).json({
      error: 'invalid_query_param',
      message: 'api_key_id must be a single string.',
    });
  }

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
  // F2-internal adversarial audit (2026-04-15): clamp LIMIT into [1, 1000].
  // The previous formula was `Math.min(parseInt(...) || 100, 1000)`, which
  // has two holes:
  //
  //   - `parseInt('-5') || 100 === -5` — -5 is truthy so the fallback is
  //     skipped. Math.min(-5, 1000) is -5. SQLite treats LIMIT -5 as
  //     "no upper bound" and returns the full orders table.
  //   - `parseInt('0') || 100 === 100` — 0 quietly maps to 100 (OK but
  //     inconsistent).
  //
  // Wrap Math.min in Math.max(1, ...) so any value below 1 rounds up to
  // 1 (including NaN via the final || 100 fallback). The authenticated
  // internal caller is trusted, but the fix bounds the worst-case
  // SELECT for ops tooling that accidentally sends ?limit=-1.
  const rawLimit = parseInt(String(limit), 10);
  const clampedLimit = Math.max(
    1,
    Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 1000),
  );
  params.push(/** @type {any} */ (clampedLimit));
  res.json(db.prepare(query).all(...params));
});

// GET /internal/orders/:id/card — privileged single-order card reveal.
// Returns raw PAN/CVV/expiry. Every call writes an audit_log entry so
// reveal activity is reviewable. Gated by requireCardReveal in addition
// to the existing requireAuth + requireInternal stack.
//
// F1-card-reveal (2026-04-15 audit): the audit write used to be a
// best-effort try/catch AFTER building the response, with the comment
// "Don't let audit-log failure block the reveal". That's the correct
// trade-off for ordinary operations — but card reveal is the exception
// because the reveal is only policy-justified BY the audit trail. If
// the audit write silently fails (disk full, corrupt table, schema
// drift), the old code shipped plaintext PAN/CVV/expiry with no paper
// trail and ops lost the ability to investigate any downstream breach.
//
// The fix:
//   1. Open the card vault first (so a decrypt failure surfaces its
//      own specific error, not as a reveal 503).
//   2. Write the audit row synchronously. On ANY failure, return 503
//      immediately and do NOT ship the card.
//   3. Only after the audit is durable, return the card JSON.
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

  // Open the vault first. A decrypt failure (GCM tag mismatch / key
  // rotation / truncated blob) surfaces through openCard's field-
  // labelled error and gets a 500 — we don't want to conflate that
  // with the audit-unavailable path below.
  const { openCard } = require('../lib/card-vault');
  let card;
  try {
    card = openCard(order);
  } catch (err) {
    console.error(`[internal] card-vault open failed for ${order.id}: ${err.message}`);
    return res.status(500).json({
      error: 'card_vault_unavailable',
      message: 'Card data could not be decrypted. Check the vault key and vault integrity.',
    });
  }

  // Audit FIRST, ship SECOND. If the audit write can't be persisted,
  // fail closed with 503 — an un-audited reveal must not happen.
  //
  // F1-internal adversarial audit (2026-04-15): route the write through
  // recordAudit() instead of a hand-rolled db.prepare INSERT. The
  // previous direct insert had a column-mismatch bug that passed the
  // literal string 'internal_card_reveal' into the actor_role column
  // instead of req.user.role. Every card reveal landed with actor_role
  // set to a constant, so operational queries like
  //   SELECT * FROM audit_log WHERE actor_role = 'owner'
  // silently EXCLUDED every card reveal, and the "which privilege
  // level performed this reveal" forensic signal was permanently
  // corrupted. Going through recordAudit() fixes the column mapping,
  // inherits the details-byte truncation cap, uses normalizeRole()
  // for consistent role encoding, and brings the write into
  // alignment with every other audit path in the codebase.
  //
  // recordAudit() already swallows its own errors (audit writes are
  // best-effort by design) so we can't rely on it to throw on
  // failure. Use a count-before / count-after strategy to verify the
  // row landed durably — timestamp-independent (no YYYY-MM-DD vs
  // YYYY-MM-DDTHH:MM:SS.sssZ format mismatch against the SQLite
  // default) and immune to clock skew. Fail-closed with 503 if the
  // post-count didn't increment.
  try {
    const dashId =
      db.prepare(`SELECT dashboard_id FROM api_keys WHERE id = ?`).get(order.api_key_id)
        ?.dashboard_id || 'system';
    const preCount = /** @type {any} */ (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log
           WHERE action = 'internal_card_reveal' AND resource_id = ?`,
        )
        .get(order.id)
    ).n;
    recordAudit({
      dashboardId: dashId,
      actor: {
        id: req.user.id || null,
        email: req.user.email,
        role: req.user.role,
      },
      action: 'internal_card_reveal',
      resourceType: 'order',
      resourceId: order.id,
      details: { api_key_id: order.api_key_id },
      ip: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });
    const postCount = /** @type {any} */ (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_log
           WHERE action = 'internal_card_reveal' AND resource_id = ?`,
        )
        .get(order.id)
    ).n;
    if (postCount !== preCount + 1) {
      throw new Error('audit row did not land in audit_log');
    }
  } catch (err) {
    console.error(`[internal] audit log write failed for card reveal: ${err.message}`);
    return res.status(503).json({
      error: 'audit_unavailable',
      message:
        'Card reveal blocked: audit log write could not be persisted. An un-audited reveal is not permitted. Try again shortly, and alert ops if this persists.',
    });
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

// Manual refund endpoint DELETED (2026-04-14). The old handler was
// guarded only by requireInternal (any @cards402.com mailbox) and
// called scheduleRefund() without checking the order's status, which
// meant any authenticated internal user could force a refund on a
// 'delivered' or 'ordering' order — draining the treasury AND leaving
// the customer with a fulfilled card. See audit finding treasury-drain-1.
//
// Automatic refunds still fire from the normal failure paths:
//   - payment-handler.js on dispatch error (DEX swap failed, etc.)
//   - vcc-callback.js on CTX 'failed' status
//   - jobs.js::recoverStuckOrders for stale ordering rows past the
//     fail-after threshold with VCC confirming the job isn't making
//     progress
//   - jobs.js::expireStaleOrders for expired pending_payment rows
//
// If ops ever needs a true manual override, add a new endpoint behind
// requirePlatformOwner that (a) verifies the order is in a refundable
// state (NOT delivered/ordering), (b) requires an explicit reason
// string, and (c) writes to admin_actions for audit. Do NOT re-enable
// this old handler.

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
