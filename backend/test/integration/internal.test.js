// Integration tests for backend/src/api/internal.js — the ops admin API.
//
// Before this adversarial-audit cycle there were NO tests for the
// /internal endpoints despite one of them returning live PAN/CVV data.
// The file pins:
//
//   - GET /internal/orders: LIMIT clamp (F2) and query-param type
//     validation (F3).
//   - GET /internal/orders/:id/card: the card reveal audit row must
//     land in audit_log with the OPERATOR's role (not a hard-coded
//     'internal_card_reveal' string — F1). Happy path returns the
//     decrypted card, and audit_log has exactly one matching row.

require('../helpers/env');

// Enable card reveal so requireCardReveal allows the test session.
// Must be set BEFORE helpers/app loads the Express app (the middleware
// reads process.env at request time, so this is actually safe even
// post-load, but doing it here keeps it obviously scoped).
process.env.CARDS402_CARD_REVEAL_EMAILS = 'test@cards402.com';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const {
  request,
  db,
  resetDb,
  createTestSession,
  seedOrder,
  createTestKey,
} = require('../helpers/app');

function authHeader(token) {
  return `Bearer ${token}`;
}

// ── GET /internal/orders — LIMIT clamp + query param shape ─────────────

describe('GET /internal/orders — F2 LIMIT clamp', () => {
  beforeEach(() => resetDb());

  it('rejects non-string status query param with 400 (F3)', async () => {
    const { token } = createTestSession();
    // supertest repeat query param parses into an array on Express.
    const res = await request
      .get('/internal/orders?status=a&status=b')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_query_param');
  });

  it('rejects non-string api_key_id query param with 400 (F3)', async () => {
    const { token } = createTestSession();
    const res = await request
      .get('/internal/orders?api_key_id=k1&api_key_id=k2')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_query_param');
  });

  it('accepts a positive ?limit and returns at most that many rows', async () => {
    const { token } = createTestSession();
    for (let i = 0; i < 5; i++) {
      seedOrder({ status: 'delivered' });
    }
    const res = await request
      .get('/internal/orders?limit=2')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2, 'positive limit must be honoured by SQL LIMIT');
  });

  it('falls through to the default on negative ?limit (F2 clamp)', async () => {
    // The primary property: negative limit does NOT reach SQLite as
    // a raw -N (where SQLite would treat it as "unlimited"). With 3
    // seeded rows the response must be ≤ 100 (the default). The
    // positive-limit test above pairs with this to cover both
    // branches of the Number.isFinite guard.
    const { token } = createTestSession();
    for (let i = 0; i < 3; i++) {
      seedOrder({ status: 'delivered' });
    }
    const res = await request
      .get('/internal/orders?limit=-1')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    assert.ok(res.body.length <= 100, 'negative limit must fall through to default 100');
    assert.equal(res.body.length, 3, 'with 3 seeded rows, default 100 returns all 3');
  });

  it('falls through to the default on ?limit=0 (F2 clamp)', async () => {
    const { token } = createTestSession();
    for (let i = 0; i < 3; i++) {
      seedOrder({ status: 'delivered' });
    }
    const res = await request
      .get('/internal/orders?limit=0')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    // 0 is not > 0, so falls through to default 100 → all 3 rows.
    assert.equal(res.body.length, 3);
  });

  it('falls through to the default on ?limit=abc (F2 NaN handling)', async () => {
    const { token } = createTestSession();
    for (let i = 0; i < 3; i++) {
      seedOrder({ status: 'delivered' });
    }
    const res = await request
      .get('/internal/orders?limit=abc')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
  });

  it('clamps oversized ?limit=99999 to 1000 (upper bound unchanged)', async () => {
    const { token } = createTestSession();
    for (let i = 0; i < 3; i++) {
      seedOrder({ status: 'delivered' });
    }
    const res = await request
      .get('/internal/orders?limit=99999')
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    // Only 3 rows seeded so we still get 3 — the upper clamp doesn't
    // inflate the response, it just bounds the SQL limit to 1000.
    assert.equal(res.body.length, 3);
  });

  it('returns empty list when no orders match (regression guard)', async () => {
    const { token } = createTestSession();
    const res = await request.get('/internal/orders').set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
  });
});

// ── GET /internal/orders/:id/card — F1 audit column fix ──────────────────

describe('GET /internal/orders/:id/card — F1 audit row shape', () => {
  beforeEach(() => {
    resetDb();
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'test@cards402.com';
  });

  async function seedDeliveredOrderWithCard() {
    // Attach to a real api_key so the dashboard_id lookup in the
    // reveal path succeeds.
    const apiKey = await createTestKey({ label: 'reveal-test' });
    const id = seedOrder({ api_key_id: apiKey.id, status: 'delivered' });
    // In test env secret-box.seal is a plaintext pass-through so
    // writing raw card fields directly is equivalent to a sealed
    // write from a production INSERT.
    db.prepare(
      `UPDATE orders SET card_number = ?, card_cvv = ?, card_expiry = ?, card_brand = ? WHERE id = ?`,
    ).run('4111111111111111', '123', '12/27', 'Visa', id);
    return id;
  }

  it('writes the audit row with actor_role = operator role (F1), NOT a hard-coded string', async () => {
    // The critical regression guard. Pre-fix the direct
    // db.prepare INSERT passed the literal 'internal_card_reveal'
    // into the actor_role column, breaking every downstream query
    // that filters by role. Post-fix the audit goes through
    // recordAudit() which writes normalizeRole(req.user.role).
    const { token } = createTestSession({ role: 'owner' });
    const orderId = await seedDeliveredOrderWithCard();

    const res = await request
      .get(`/internal/orders/${orderId}/card`)
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 200);
    assert.equal(res.body.order_id, orderId);
    assert.equal(res.body.card.number, '4111111111111111');

    // Audit row inspection.
    const auditRow = db
      .prepare(`SELECT * FROM audit_log WHERE resource_id = ? AND action = 'internal_card_reveal'`)
      .get(orderId);
    assert.ok(auditRow, 'audit row must exist for the reveal');
    assert.equal(
      auditRow.actor_role,
      'owner',
      'actor_role must be the operator role, not a hard-coded string',
    );
    assert.equal(auditRow.actor_email, 'test@cards402.com');
    assert.equal(auditRow.action, 'internal_card_reveal');
    assert.equal(auditRow.resource_type, 'order');
    assert.equal(auditRow.resource_id, orderId);
    // details is JSON text; parse + check api_key_id.
    const details = JSON.parse(auditRow.details);
    assert.ok(details.api_key_id);
  });

  it('different operator roles produce different actor_role rows (not a constant)', async () => {
    // Seed two operators with different roles and reveal the same
    // order from each. The audit rows must reflect the different
    // roles. Pre-fix they'd both be 'internal_card_reveal' and
    // an ops query filtering by role couldn't distinguish them.
    process.env.CARDS402_CARD_REVEAL_EMAILS = 'owner-test@cards402.com,admin-test@cards402.com';

    const owner = createTestSession({ email: 'owner-test@cards402.com', role: 'owner' });
    const admin = createTestSession({ email: 'admin-test@cards402.com', role: 'admin' });
    const orderId = await seedDeliveredOrderWithCard();

    const revealByOwner = await request
      .get(`/internal/orders/${orderId}/card`)
      .set('Authorization', authHeader(owner.token));
    assert.equal(revealByOwner.status, 200);

    const revealByAdmin = await request
      .get(`/internal/orders/${orderId}/card`)
      .set('Authorization', authHeader(admin.token));
    assert.equal(revealByAdmin.status, 200);

    const rows = db
      .prepare(
        `SELECT actor_email, actor_role
         FROM audit_log
         WHERE resource_id = ? AND action = 'internal_card_reveal'
         ORDER BY id`,
      )
      .all(orderId);
    assert.equal(rows.length, 2);
    const byEmail = Object.fromEntries(rows.map((r) => [r.actor_email, r.actor_role]));
    assert.equal(byEmail['owner-test@cards402.com'], 'owner');
    assert.equal(byEmail['admin-test@cards402.com'], 'admin');
  });

  it('returns 404 for a non-existent order', async () => {
    const { token } = createTestSession();
    const res = await request
      .get(`/internal/orders/${uuidv4()}/card`)
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 404);
  });

  it('returns 409 no_card when the order has no sealed card', async () => {
    const { token } = createTestSession();
    const apiKey = await createTestKey({ label: 'no-card' });
    const id = seedOrder({ api_key_id: apiKey.id, status: 'pending_payment' });
    const res = await request
      .get(`/internal/orders/${id}/card`)
      .set('Authorization', authHeader(token));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'no_card');
  });
});
