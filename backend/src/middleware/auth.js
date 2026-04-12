// @ts-check
// Shared API key authentication middleware for /v1 routes.
// Uses key_prefix for O(1) candidate lookup, then bcrypt for verification.
// Key format: cards402_<48 random hex chars>; key_prefix = chars 9-21 of the key.

const bcrypt = require('bcryptjs');
const db = require('../db');

module.exports = async function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'missing_api_key' });

  // Extract prefix to narrow candidates — falls back to full scan for keys
  // created before the key_prefix column was added (key_prefix IS NULL).
  const keyPrefix = key.startsWith('cards402_') && key.length >= 21 ? key.slice(9, 21) : null;

  const candidates = keyPrefix
    ? db
        .prepare(
          `SELECT * FROM api_keys WHERE enabled = 1 AND (key_prefix = ? OR key_prefix IS NULL)`,
        )
        .all(keyPrefix)
    : db.prepare(`SELECT * FROM api_keys WHERE enabled = 1`).all();

  for (const candidate of /** @type {any[]} */ (candidates)) {
    if (await bcrypt.compare(key, candidate.key_hash)) {
      if (candidate.expires_at && new Date(candidate.expires_at) < new Date()) {
        return res
          .status(401)
          .json({ error: 'api_key_expired', message: 'This API key has expired.' });
      }
      req.apiKey = candidate;
      // Track last-seen time for agent connection status (fire-and-forget)
      db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(
        candidate.id,
      );
      return next();
    }
  }

  return res.status(401).json({ error: 'invalid_api_key' });
};
