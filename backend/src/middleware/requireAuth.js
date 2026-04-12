// @ts-check
// requireAuth middleware — validates session token from Authorization: Bearer header.
// Attaches req.user = { id, email, role } on success.

const crypto = require('crypto');
const db = require('../db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function requireAuth(req, res, next) {
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

  req.user = row;
  next();
}

module.exports = requireAuth;
