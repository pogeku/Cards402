// @ts-check
// Admin action audit log — every destructive / financial admin operation
// gets a row in `admin_actions`. This is the replay log for disputes and
// ops debugging: who approved what, who refunded which order, who unfroze
// the system, when. Migration 12.
//
// Audit finding A-17.
//
// Usage:
//   const { recordAdminAction } = require('../lib/admin-audit');
//   recordAdminAction(req, 'refund_order', 'order', orderId, { reason });
//
// The helper reads the actor email from req.user (set by requireAuth),
// ip from req.ip, and request_id from req.id (set by the global correlation
// middleware). Never throws — a failed audit write should not break the
// user-visible operation, but it IS logged.

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { log, event: bizEvent } = require('./logger');

const insert = db.prepare(`
  INSERT INTO admin_actions (id, actor_email, action, target_type, target_id, metadata, ip, request_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function recordAdminAction(req, action, targetType, targetId, metadata = {}) {
  try {
    const actor = req.user?.email || req.user?.id || 'unknown';
    insert.run(
      uuidv4(),
      actor,
      action,
      targetType,
      targetId || null,
      JSON.stringify(metadata || {}),
      req.ip || null,
      req.id || null,
    );
    bizEvent('admin.action', {
      actor,
      action,
      target_type: targetType,
      target_id: targetId,
      req_id: req.id,
    });
  } catch (err) {
    log('error', 'admin-audit insert failed', {
      error: err.message,
      action,
      target_type: targetType,
      target_id: targetId,
    });
  }
}

module.exports = { recordAdminAction };
