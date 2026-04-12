// @ts-check
// requireDashboard middleware — looks up the dashboard for req.user.
// Must be used after requireAuth. Attaches req.dashboard on success.

const db = require('../db');

module.exports = function requireDashboard(req, res, next) {
  const dashboard = db.prepare(`SELECT * FROM dashboards WHERE user_id = ?`).get(req.user.id);
  if (!dashboard) return res.status(404).json({ error: 'no_dashboard', message: 'No dashboard found. Please contact support.' });
  req.dashboard = dashboard;
  next();
};
