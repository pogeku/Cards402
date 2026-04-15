// @ts-check
// requireDashboard middleware — looks up the dashboard for req.user.
// Must be used after requireAuth. Attaches req.dashboard on success.
//
// Adversarial audit 2026-04-15:
//
//   F1-requireDashboard: guard req.user before dereferencing req.user.id.
//     Pre-fix, if the middleware order was wrong (or a future refactor
//     removed requireAuth from a router chain), the call `req.user.id`
//     would throw TypeError: Cannot read property 'id' of undefined and
//     cascade to a 500. The auth verdict at that point is ambiguous —
//     the user got a 500 (server error) when they should have gotten
//     a 401 (authentication required), which leaks implementation
//     detail and can mask a real config mistake. Fail closed to 401.
//
//   F2-requireDashboard: deterministic dashboard selection. The
//     `dashboards` table has only an index on user_id, no UNIQUE
//     constraint (src/db.js:287-294). Today the signup flow creates
//     exactly one row per user, but a retry in that flow, a future
//     multi-dashboard feature, or a migration quirk could leave a
//     user with two+ rows. Pre-fix, `.get()` with no ORDER BY returns
//     an arbitrary row — different requests from the same user could
//     see different dashboards and the user would silently oscillate
//     between them. Added ORDER BY created_at ASC, id ASC to pin the
//     earliest (primary) dashboard and console.warn if duplicates are
//     observed so ops can clean up the data.

const db = require('../db');

// F2-requireDashboard: cap the duplicate-detection SELECT so a user
// with hundreds of accidental dashboard rows doesn't make ops logs
// explode. 2 is enough to prove "more than one exists" and trigger
// a single warn.
const DUP_CHECK_LIMIT = 2;

module.exports = function requireDashboard(req, res, next) {
  // F1-requireDashboard: fail closed on missing or malformed req.user
  // rather than letting the undefined.id crash cascade to 500.
  if (!req.user || typeof req.user.id !== 'string' || req.user.id.length === 0) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'This endpoint requires an authenticated user session.',
    });
  }

  // F2-requireDashboard: ORDER BY created_at ASC, id ASC pins the
  // earliest-created dashboard as the user's primary. created_at is
  // stored with second-granularity text so a tiebreak on `id` (UUID
  // text, stable across process restarts) ensures determinism even
  // within the same second.
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT * FROM dashboards
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(req.user.id, DUP_CHECK_LIMIT)
  );

  if (rows.length === 0) {
    return res
      .status(404)
      .json({ error: 'no_dashboard', message: 'No dashboard found. Please contact support.' });
  }

  if (rows.length > 1) {
    // F2: surface duplicate dashboards to ops. Don't throw — the user
    // still has a valid primary row to use — but log loudly so the
    // underlying data integrity issue is visible.
    console.warn(
      `[requireDashboard] user ${req.user.id} has multiple dashboard rows ` +
        `(detected ${rows.length}+). Using earliest: id=${rows[0].id}. ` +
        `Ops: investigate duplicates in dashboards table.`,
    );
  }

  req.dashboard = rows[0];
  next();
};
