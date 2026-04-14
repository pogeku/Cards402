// Integration test helper — creates a supertest agent for the Express app
// and utilities for seeding test data.

require('./env'); // must be first

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const supertest = require('supertest');
const appModule = require('../../src/app');
const db = require('../../src/db');

const request = supertest(appModule);

/**
 * Create a test API key and return both the raw key (for use in headers)
 * and the record ID.
 */
async function createTestKey({
  label = 'test-agent',
  spendLimit = null,
  defaultWebhookUrl = null,
  suspended = 0,
  expiresAt = null,
  enabled = 1,
} = {}) {
  const rawKey = `cards402_${crypto.randomBytes(24).toString('hex')}`;
  // Low bcrypt cost (4) for fast tests
  const keyHash = await bcrypt.hash(rawKey, 4);
  const id = uuidv4();
  const webhookSecret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
  // Match production: src/api/dashboard.js:332 stores chars 9-21 as the
  // prefix index so the auth middleware's O(1) lookup path fires in tests
  // instead of falling back to the legacy NULL-prefix scan.
  const keyPrefix = rawKey.slice(9, 21);

  db.prepare(
    `
    INSERT INTO api_keys
      (id, key_hash, key_prefix, label, spend_limit_usdc, webhook_secret,
       default_webhook_url, enabled, suspended, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    keyHash,
    keyPrefix,
    label,
    spendLimit,
    webhookSecret,
    defaultWebhookUrl,
    enabled,
    suspended,
    expiresAt,
  );

  return { id, key: rawKey, webhookSecret };
}

/**
 * Insert an order directly into the DB (bypasses API auth / rate limits).
 */
function seedOrder(fields = {}) {
  const id = fields.id || uuidv4();
  db.prepare(
    `
    INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id)
    VALUES (@id, @status, @amount_usdc, @payment_asset, @api_key_id)
  `,
  ).run({
    id,
    status: fields.status || 'pending_payment',
    amount_usdc: fields.amount_usdc || '10.00',
    payment_asset: fields.payment_asset || 'usdc',
    api_key_id: fields.api_key_id || null,
  });
  return id;
}

/**
 * Create a test user and session directly in the DB (no email required).
 * Returns { token, userId } — use token as 'Authorization: Bearer <token>' header.
 */
function createTestSession({ email = 'test@cards402.com', role = 'owner' } = {}) {
  let user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user) {
    const id = require('uuid').v4();
    db.prepare(`INSERT INTO users (id, email, role) VALUES (?, ?, ?)`).run(id, email, role);
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = require('crypto').createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`).run(
    require('uuid').v4(),
    user.id,
    tokenHash,
    expiresAt,
  );
  return { token: rawToken, userId: user.id };
}

/**
 * Reset all tables between tests.
 */
function resetDb() {
  db.prepare(`DELETE FROM orders`).run();
  db.prepare(`DELETE FROM api_keys`).run();
  db.prepare(`DELETE FROM idempotency_keys`).run();
  db.prepare(`DELETE FROM webhook_queue`).run();
  db.prepare(`DELETE FROM sessions`).run();
  db.prepare(`DELETE FROM users`).run();
  db.prepare(`DELETE FROM auth_codes`).run();
  // Phase 3 tables — audit, alerts, webhook deliveries. Tests that write
  // to these need them cleared between cases so state doesn't leak.
  db.prepare(`DELETE FROM audit_log`).run();
  db.prepare(`DELETE FROM alert_rules`).run();
  db.prepare(`DELETE FROM alert_firings`).run();
  db.prepare(`DELETE FROM webhook_deliveries`).run();
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'frozen'`).run();
  db.prepare(`UPDATE system_state SET value = '0' WHERE key = 'consecutive_failures'`).run();
  db.prepare(`DELETE FROM system_state WHERE key = 'vcc_token'`).run();
  db.prepare(`DELETE FROM system_state WHERE key = 'ctx_refresh_token'`).run();
  db.prepare(`DELETE FROM system_state WHERE key = 'ctx_access_token'`).run();
}

module.exports = { request, db, createTestKey, createTestSession, seedOrder, resetDb };
