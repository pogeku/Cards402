// @ts-check
// Shared API key authentication middleware for /v1 routes.
// Uses key_prefix for O(1) candidate lookup, then bcrypt for verification.
// Key format: cards402_<48 random hex chars>; key_prefix = chars 9-21 of the key.

const bcrypt = require('bcryptjs');
const db = require('../db');

// cards402_<48 hex> → 9 + 48 = 57 chars exactly. We allow the header
// to be slightly shorter (down to 21 chars = prefix region) so
// obviously-truncated keys still route through the prefix index rather
// than falling back to a full-table bcrypt scan (a DoS amplifier pre-F).
const KEY_MIN_LENGTH = 21; // cards402_ (9) + 12-char prefix
const KEY_MAX_LENGTH = 128; // anything longer is either wrong or hostile

module.exports = async function auth(req, res, next) {
  const rawKey = req.headers['x-api-key'];
  // Coerce to a single string. Express hands duplicated headers through
  // as either a joined string or (for some header names) an array; reject
  // arrays outright rather than risk `.startsWith` throwing below.
  if (!rawKey) return res.status(401).json({ error: 'missing_api_key' });
  if (typeof rawKey !== 'string') return res.status(401).json({ error: 'invalid_api_key' });
  const key = rawKey;

  // Early rejections — no DB work, no bcrypt work. A malformed key used
  // to trigger a full-table scan with a bcrypt compare against every row,
  // which let an attacker turn one HTTP request into O(n) bcrypt work on
  // our box. Now we bail before touching the DB.
  if (!key.startsWith('cards402_') || key.length < KEY_MIN_LENGTH || key.length > KEY_MAX_LENGTH) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  const keyPrefix = key.slice(9, 21);

  // Use the prefix index to narrow candidates. The `key_prefix IS NULL`
  // fallback catches any legacy rows created before the column existed
  // (very old installs); it's typically zero extra rows on modern DBs.
  const candidates = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT * FROM api_keys WHERE enabled = 1 AND (key_prefix = ? OR key_prefix IS NULL)`,
      )
      .all(keyPrefix)
  );

  for (const candidate of candidates) {
    let matched = false;
    try {
      matched = await bcrypt.compare(key, candidate.key_hash);
    } catch (err) {
      // A corrupted key_hash (malformed bcrypt string) would otherwise
      // throw all the way out through the async middleware and 500 the
      // request — effectively locking the whole endpoint for anyone who
      // happens to share a prefix with the bad row. Swallow and skip.
      console.warn(
        `[auth] bcrypt.compare threw on api_key_id=${candidate.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!matched) continue;

    // Post-match gates. Each returns a specific error so legitimate key
    // holders can tell the difference between "your key is wrong" and
    // "your key is suspended / expired" — someone without the key can
    // never reach these branches at all.
    if (candidate.expires_at && new Date(candidate.expires_at) < new Date()) {
      return res
        .status(401)
        .json({ error: 'api_key_expired', message: 'This API key has expired.' });
    }
    if (candidate.suspended) {
      // Suspended was previously only enforced at order-creation time
      // via src/policy.js:37. Every read endpoint (GET /v1/orders/:id,
      // GET /v1/usage, /v1/orders list, etc.) let suspended agents
      // straight through. Blocking at auth is the right place — one
      // gate, covers every /v1/* route.
      return res.status(401).json({
        error: 'api_key_suspended',
        message: 'This API key has been suspended by the operator.',
      });
    }

    req.apiKey = candidate;
    // Track last-seen time for agent connection status (fire-and-forget)
    db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(candidate.id);
    return next();
  }

  return res.status(401).json({ error: 'invalid_api_key' });
};
