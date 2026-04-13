// @ts-check
// Auth routes — email login code flow.
//
// Flow:
//   1. POST /auth/login   { email }        → sends 6-digit code to email
//   2. POST /auth/verify  { email, code }  → verifies code, creates session, returns token
//   3. POST /auth/logout                   → invalidates session
//   4. GET  /auth/me                       → returns current user from session token
//
// First user to successfully verify becomes the owner.
// Subsequent users who verify are created as role='user'.
// Codes expire after 15 minutes. Sessions last 7 days.

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { sendLoginCode } = require('../lib/email');
const { isPlatformOwner } = require('../lib/platform');

const router = Router();

const CODE_TTL_MINUTES = 15;
const CODE_MAX_PER_WINDOW = 3;
const SESSION_TTL_DAYS = 7;

// Adversarial audit F3 — OTP brute-force protection.
//
// The login code is 6 digits (10^6 possible values) and the old
// /auth/verify had no per-IP throttling and no per-email failed-attempt
// counter, so a 10M-request brute force could have guessed any active
// code in under an hour. Two layers here:
//
//  1. Per-IP express-rate-limit on /auth/verify: 20 attempts per 10
//     minutes is well above any legitimate user flow (they type one
//     code once, maybe retype once if they fat-fingered) while cutting
//     the keyspace-search rate by ~5 orders of magnitude.
//
//  2. Per-email failed-attempts lockout on the auth_codes row itself
//     (see the inline logic in POST /auth/verify). After 5 bad tries,
//     every active code for the email is marked used, forcing the user
//     back through /auth/login to mint a fresh one.
const VERIFY_FAILED_ATTEMPT_LIMIT = 5;
const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => /** @type {any} */ (ipKeyGenerator)(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many verification attempts from this IP. Try again in a few minutes.',
    }),
});

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateCode() {
  // 6-digit code, zero-padded
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// ── POST /auth/login ─────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res
      .status(400)
      .json({ error: 'invalid_email', message: 'A valid email address is required.' });
  }

  const addr = normalizeEmail(email);

  // Bootstrap guard: if OWNER_EMAIL is set and no users exist yet, reject non-matching emails.
  // Prevents a race where a stranger claims owner on a fresh instance before the real owner.
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (ownerEmail) {
    const userCount = /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n;
    if (userCount === 0 && addr !== ownerEmail) {
      // Return generic success to avoid disclosing that the instance is unconfigured
      return res.json({ ok: true });
    }
  }

  // Rate limit: max 3 active (unused, unexpired) codes per email per window
  const recentCount = /** @type {any} */ (
    db
      .prepare(
        `
    SELECT COUNT(*) AS n FROM auth_codes
    WHERE email = ?
      AND used_at IS NULL
      AND datetime(expires_at) > datetime('now')
  `,
      )
      .get(addr)
  ).n;

  if (recentCount >= CODE_MAX_PER_WINDOW) {
    return res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many login attempts. Wait a few minutes and try again.',
    });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(
    `
    INSERT INTO auth_codes (id, email, code_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(uuidv4(), addr, hashToken(code), expiresAt);

  // In non-production, log that a code was sent (but not the value itself).
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[auth] LOGIN CODE sent to ${addr} (expires in ${CODE_TTL_MINUTES}min)`);
  }

  try {
    await sendLoginCode(addr, code);
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[auth] email send failed:', err.message);
      return res.status(500).json({
        error: 'email_failed',
        message: 'Failed to send login code. Check SMTP configuration.',
      });
    }
    // Non-production: code already logged above — proceed without email
    console.warn(`[auth] email skipped (${err.message}) — use the logged code above`);
  }

  // Generic response — don't reveal whether the email exists or was accepted
  res.json({ ok: true });
});

// ── POST /auth/verify ────────────────────────────────────────────────────────

router.post('/verify', verifyLimiter, (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res
      .status(400)
      .json({ error: 'missing_fields', message: 'email and code are required.' });
  }

  const addr = normalizeEmail(email);
  const codeHash = hashToken(String(code).trim());

  // Atomic: mark code used in one statement so concurrent verify requests
  // with the same code cannot both succeed (race-free single-use enforcement).
  const now = new Date().toISOString();
  const used = db
    .prepare(
      `
    UPDATE auth_codes SET used_at = ?
    WHERE email = ?
      AND code_hash = ?
      AND used_at IS NULL
      AND datetime(expires_at) > datetime('now')
  `,
    )
    .run(now, addr, codeHash);

  if (used.changes === 0) {
    // F3: bad code. Increment failed_attempts on every active code for this
    // email (rather than only the exact row, because the attacker is trying
    // code values they don't know — there's no "matching row" to tick).
    // Once any active row exceeds the threshold we invalidate everything.
    db.prepare(
      `
      UPDATE auth_codes
      SET failed_attempts = failed_attempts + 1
      WHERE email = ?
        AND used_at IS NULL
        AND datetime(expires_at) > datetime('now')
    `,
    ).run(addr);
    const maxFails = /** @type {any} */ (
      db
        .prepare(
          `
      SELECT MAX(failed_attempts) AS m FROM auth_codes
      WHERE email = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    `,
        )
        .get(addr)
    ).m;
    if (maxFails !== null && maxFails >= VERIFY_FAILED_ATTEMPT_LIMIT) {
      // Lock out: mark every active code used so further verify attempts
      // can't make progress until the user requests a fresh code via
      // /auth/login (which itself is rate-limited per email).
      db.prepare(
        `
        UPDATE auth_codes SET used_at = ?
        WHERE email = ? AND used_at IS NULL
      `,
      ).run(now, addr);
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Too many incorrect codes for this email. Request a new login code and try again.',
      });
    }
    return res.status(401).json({ error: 'invalid_code', message: 'Invalid or expired code.' });
  }

  // Find or create user
  let user = /** @type {any} */ (db.prepare(`SELECT * FROM users WHERE email = ?`).get(addr));
  if (!user) {
    const isFirst =
      /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n === 0;
    const id = uuidv4();
    db.prepare(
      `
      INSERT INTO users (id, email, role) VALUES (?, ?, ?)
    `,
    ).run(id, addr, isFirst ? 'owner' : 'user');
    user = /** @type {any} */ (db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
  }

  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(now, user.id);

  // Find or create dashboard for this user
  let dashboard = /** @type {any} */ (
    db.prepare(`SELECT id, name FROM dashboards WHERE user_id = ?`).get(user.id)
  );
  if (!dashboard) {
    const dashId = uuidv4();
    const name = addr.split('@')[0];
    db.prepare(`INSERT INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`).run(
      dashId,
      user.id,
      name,
    );
    dashboard = { id: dashId, name };
  }

  // Create session
  const rawToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  db.prepare(
    `
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(uuidv4(), user.id, hashToken(rawToken), sessionExpiresAt);

  res.json({
    token: rawToken,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      // Platform-owner is a deployment-level attribute (CARDS402_PLATFORM_OWNER_EMAIL).
      // It controls whether the user sees system-level alerts and similar
      // platform-operator UI. Distinct from the dashboard-scoped role.
      is_platform_owner: isPlatformOwner(user.email),
    },
    dashboard: { id: dashboard.id, name: dashboard.name },
  });
});

// ── POST /auth/logout ────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
  }
  res.json({ ok: true });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const row = db
    .prepare(
      `
    SELECT u.id, u.email, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ?
      AND datetime(s.expires_at) > datetime('now')
  `,
    )
    .get(hashToken(token));

  if (!row) return res.status(401).json({ error: 'unauthorized' });

  // Wrap in { user } to match /auth/verify's response shape — both web
  // clients read data.user.role, so a flat response made /admin think a
  // real owner was a non-owner and redirect them to /dashboard.
  res.json({
    user: {
      ...row,
      is_platform_owner: isPlatformOwner(row.email),
    },
  });
});

module.exports = router;
