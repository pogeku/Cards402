// @ts-check
// requireAuth middleware — validates session token from Authorization: Bearer header.
// Attaches req.user = { id, email, role, is_platform_owner } on success.

const crypto = require('crypto');
const db = require('../db');
const { isPlatformOwner } = require('../lib/platform');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
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
