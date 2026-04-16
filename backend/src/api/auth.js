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
const { recordAudit } = require('../lib/audit');

const router = Router();

const CODE_TTL_MINUTES = 15;
const CODE_MAX_PER_WINDOW = 3;
const SESSION_TTL_DAYS = 7;

// ── Rate limiters ──────────────────────────────────────────────────────────
//
// /auth/login — caps how many codes can be minted per IP. Sends an email on
// every success, so each request has a real cost (Resend quota +
// sender-reputation risk if we get flagged for volume). Tight limit, IP-keyed.
//
// /auth/verify — two-layer brute-force protection for 6-digit OTP codes
// (adversarial audit F3). The inline per-email failed-attempts lockout is
// the tighter of the two; the IP limiter just keeps distributed guessers
// from cycling addresses to avoid the per-email ceiling.
//
// /auth/me and /auth/logout intentionally bypass these limits — /auth/me
// is a pure session-read that the dashboard layout calls on every hard
// refresh, and /auth/logout is an idempotent DELETE that does nothing on
// a missing-or-stale token. Rate-limiting either would cause legit users
// on NAT'd networks to collide with each other during normal browsing
// while giving no real brute-force protection (neither endpoint exposes
// anything the attacker couldn't already learn).
const VERIFY_FAILED_ATTEMPT_LIMIT = 5;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) =>
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many login requests from this IP. Try again in a few minutes.',
    }),
});

const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) =>
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

// Adversarial audit F2-auth (2026-04-15): coerce client IP to a
// single string. `req.headers['x-forwarded-for']` is typed
// `string | string[] | undefined` in Express — when a proxy sets
// the header twice via `add`, Node returns it as an array. Passing
// an array directly into recordAudit (which expects a string column)
// violated the type contract and produced two pre-existing
// `TS2322: string | string[] is not assignable to string` errors
// flagged in every earlier typecheck. Central helper so the fix is
// applied consistently across every call site.
function clientIp(req) {
  if (req.ip) return String(req.ip);
  const xff = req.headers?.['x-forwarded-for'];
  if (!xff) return null;
  if (Array.isArray(xff)) return xff.length > 0 ? String(xff[0]) : null;
  // A single X-Forwarded-For string can itself be a comma-separated
  // proxy chain like "client, proxy1, proxy2". The left-most entry
  // is the original client address.
  const first = String(xff).split(',')[0]?.trim();
  return first || null;
}

function clientUserAgent(req) {
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  if (Array.isArray(ua)) return ua.length > 0 ? String(ua[0]) : null;
  return String(ua);
}

// F1-auth-routes (2026-04-16): extract and sanitise the Bearer token
// from the Authorization header. Mirrors the F1/F2-requireAuth fix but
// applied to /auth/logout and /auth/me which bypass the requireAuth
// middleware entirely.
//
// Two pre-fix bugs:
//   (1) Array-valued Authorization header (Node returns string[] on
//       duplicates). Arrays have no `.replace` method → the token
//       value was `undefined` → `hashToken(undefined)` threw
//       `TypeError: The "data" argument must be of type string...`
//       from crypto.Hash.update → 500 response instead of 401.
//   (2) Trailing whitespace preserved after strip: 'Bearer xyz '
//       → 'xyz ' → hashToken('xyz ') ≠ hashToken('xyz') → session
//       lookup misses → silent logout failure or phantom 401 on /me.
function extractBearerToken(req) {
  let raw = req.headers?.authorization;
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return null;
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 ? token : null;
}

// ── POST /auth/login ─────────────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req, res) => {
  // Adversarial audit F1-auth (2026-04-15): reject requests whose
  // body isn't a plain JSON object upfront. Without this guard a
  // request with no Content-Type, an array body, or a null body
  // crashed the destructure `const { email } = req.body` with
  // `Cannot destructure property 'email' of 'undefined'` — Express
  // returned 500 instead of a clear 400. Same shape guard as the
  // one added to POST /v1/orders in an earlier cycle.
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'Request body must be a JSON object (set Content-Type: application/json).',
    });
  }

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
  // F1-auth: same shape guard as /auth/login. Additionally check
  // that email and code are strings — the previous code only checked
  // truthiness, so an array email like `["a@b.com"]` would reach
  // `normalizeEmail(email).trim()`, which doesn't exist on arrays
  // and crashes with 500.
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'Request body must be a JSON object (set Content-Type: application/json).',
    });
  }
  const { email, code } = req.body;
  if (!email || !code || typeof email !== 'string' || typeof code !== 'string') {
    return res
      .status(400)
      .json({ error: 'missing_fields', message: 'email and code are required strings.' });
  }

  const addr = normalizeEmail(email);
  const codeHash = hashToken(code.trim());

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

  // Adversarial audit F3-auth (2026-04-15): wrap the find-or-create
  // user/dashboard block in a db.transaction so the SELECT COUNT →
  // INSERT user atomicity is explicit and does not depend on the
  // surrounding handler being synchronous. On a fresh instance the
  // `isFirst` check and the INSERT together decide whether the new
  // user gets `role = 'owner'`. Today the handler is fully sync so
  // Node's event loop serialises concurrent /auth/verify calls and
  // the race can't happen — but any future refactor that adds an
  // `await` between the count and the INSERT (e.g. a password hash,
  // a webhook call, a policy check) would re-open a
  // "two owners on fresh install" window with no type-system or
  // test-signal warning. The transaction makes the invariant
  // explicit and robust to that change. better-sqlite3 transactions
  // are fully sync so this also enforces that future async code
  // cannot accidentally leak into this block.
  const userBootstrap = db.transaction((nowIso) => {
    let u = /** @type {any} */ (db.prepare(`SELECT * FROM users WHERE email = ?`).get(addr));
    if (!u) {
      const isFirst =
        /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).n === 0;
      const id = uuidv4();
      db.prepare(`INSERT INTO users (id, email, role) VALUES (?, ?, ?)`).run(
        id,
        addr,
        isFirst ? 'owner' : 'user',
      );
      u = /** @type {any} */ (db.prepare(`SELECT * FROM users WHERE id = ?`).get(id));
    }
    db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(nowIso, u.id);

    let d = /** @type {any} */ (
      db.prepare(`SELECT id, name FROM dashboards WHERE user_id = ?`).get(u.id)
    );
    if (!d) {
      const dashId = uuidv4();
      const name = addr.split('@')[0];
      db.prepare(`INSERT INTO dashboards (id, user_id, name) VALUES (?, ?, ?)`).run(
        dashId,
        u.id,
        name,
      );
      d = { id: dashId, name };
    }
    return { user: u, dashboard: d };
  });
  const { user, dashboard } = userBootstrap(now);

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

  // Audit trail for session creation — the single most important
  // forensic event for insider-threat investigations. Before this,
  // login success was invisible in audit_log: an attacker who forged
  // a code or phished an operator could gain a session and ops would
  // see zero record of it. Now every successful verify writes a row
  // scoped to the user's dashboard, with the user agent + ip for
  // device correlation across sessions.
  recordAudit({
    dashboardId: dashboard.id,
    actor: { id: user.id, email: user.email, role: user.role },
    action: 'auth.session_created',
    resourceType: 'session',
    resourceId: user.id,
    details: {
      first_login: !user.last_login_at,
      role: user.role,
      is_platform_owner: isPlatformOwner(user.email),
    },
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  });

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
  const token = extractBearerToken(req);
  if (token) {
    // Look up the user + dashboard BEFORE deleting the session so the
    // audit row can be attributed to the right dashboard_id. If the
    // session is already invalid we skip — no audit row for a no-op
    // logout.
    const row = /** @type {any} */ (
      db
        .prepare(
          `SELECT u.id AS user_id, u.email, u.role, d.id AS dashboard_id
           FROM sessions s
           JOIN users u ON s.user_id = u.id
           LEFT JOIN dashboards d ON d.user_id = u.id
           WHERE s.token_hash = ?`,
        )
        .get(hashToken(token))
    );
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
    if (row && row.dashboard_id) {
      recordAudit({
        dashboardId: row.dashboard_id,
        actor: { id: row.user_id, email: row.email, role: row.role },
        action: 'auth.session_deleted',
        resourceType: 'session',
        resourceId: row.user_id,
        ip: clientIp(req),
        userAgent: clientUserAgent(req),
      });
    }
  }
  res.json({ ok: true });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  const token = extractBearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const row = /** @type {any} */ (
    db
      .prepare(
        `
    SELECT u.id, u.email, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ?
      AND datetime(s.expires_at) > datetime('now')
  `,
      )
      .get(hashToken(token))
  );

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
