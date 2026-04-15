// @ts-check
// requireAuth middleware — validates session token from Authorization: Bearer header.
// Attaches req.user = { id, email, role, is_platform_owner } on success.
//
// Adversarial audit 2026-04-15:
//
//   F1-requireAuth: defensive string coercion on req.headers.authorization.
//     Pre-fix, a duplicate Authorization header (misconfigured reverse
//     proxy, hostile client, or two-pass fetch) made Node's http parser
//     return `string | string[]`. Arrays don't have `.replace`, so the
//     `authHeader?.replace(...)` expression evaluated to `undefined(...)`
//     which threw TypeError cascading to 500 — a server-error response
//     on what should have been a plain 401. Same coercion pattern
//     applied to audit.js (F6), requireCardReveal, and orders.js.
//
//   F2-requireAuth: trim the token after stripping the "Bearer " prefix.
//     Pre-fix, a trailing whitespace (stray newline, trailing space on
//     copy-paste, buggy client library appending \r) stayed in the
//     extracted token. hashToken('xyz ') != hashToken('xyz'), so the
//     legit session holder bounced with 401 and had no signal that
//     their header was the problem. Now the token is trimmed before
//     hashing so common whitespace mistakes still auth correctly.

const crypto = require('crypto');
const db = require('../db');
const { isPlatformOwner } = require('../lib/platform');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Coerce the Authorization header to a single string. Node's http parser
 * returns `string | string[] | undefined`; a duplicated header becomes
 * an array, which breaks downstream `.replace` / `.trim` calls with a
 * cryptic TypeError. Take the first element of an array or return null.
 * @param {unknown} header
 * @returns {string | null}
 */
function coerceAuthHeader(header) {
  if (typeof header === 'string') return header;
  if (Array.isArray(header) && typeof header[0] === 'string') return header[0];
  return null;
}

function requireAuth(req, res, next) {
  // F1-requireAuth: coerce array-valued header to a single string before
  // touching any string methods. Fail closed to 401 on anything else.
  const rawAuth = coerceAuthHeader(req.headers?.authorization);
  if (!rawAuth) return res.status(401).json({ error: 'unauthorized' });

  // F2-requireAuth: strip "Bearer " then trim so trailing whitespace
  // / CR / LF from a sloppy client doesn't desync the token hash.
  const token = rawAuth.replace(/^Bearer\s+/i, '').trim();
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

  // Stamp the platform-owner flag on every authenticated request so
  // downstream handlers can gate on it without re-reading env or
  // re-querying the DB. Distinct from the dashboard-scoped role —
  // platform ownership is a deployment attribute, not a tenant role.
  req.user = { ...row, is_platform_owner: isPlatformOwner(row.email) };
  next();
}

module.exports = requireAuth;
