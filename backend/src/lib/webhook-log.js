// @ts-check
// Webhook delivery log. Every outbound webhook firing (success or
// failure) gets persisted with request body, response code, latency,
// and signing info. Operators can replay or debug webhook problems
// from the dashboard without shelling into the server.
//
// Context discovery: fireWebhook() doesn't know which dashboard the
// payload belongs to, but nearly every webhook payload carries an
// `order_id`. We look up the owning dashboard via orders → api_keys →
// dashboards. If no order_id is present (e.g. a test webhook), the
// caller passes context explicitly.

/** @type {any} */
const db = require('../db');

const lookupByOrder = db.prepare(`
  SELECT o.api_key_id AS api_key_id, k.dashboard_id AS dashboard_id
  FROM orders o
  LEFT JOIN api_keys k ON o.api_key_id = k.id
  WHERE o.id = ?
`);

const insertStmt = db.prepare(`
  INSERT INTO webhook_deliveries (
    dashboard_id, api_key_id, url, method, request_body,
    response_status, response_body, latency_ms, error, signature
  ) VALUES (
    @dashboard_id, @api_key_id, @url, @method, @request_body,
    @response_status, @response_body, @latency_ms, @error, @signature
  )
`);

/**
 * @param {string | null | undefined} orderId
 * @returns {{ dashboardId: string | null; apiKeyId: string | null }}
 */
function deriveContextFromOrder(orderId) {
  if (!orderId) return { dashboardId: null, apiKeyId: null };
  const row = /** @type {any} */ (lookupByOrder.get(orderId));
  if (!row) return { dashboardId: null, apiKeyId: null };
  return { dashboardId: row.dashboard_id ?? null, apiKeyId: row.api_key_id ?? null };
}

/**
 * @typedef {Object} RecordInput
 * @property {string} url
 * @property {string} [method]
 * @property {unknown} requestBody
 * @property {number} [responseStatus]
 * @property {string} [responseBody]
 * @property {number} [latencyMs]
 * @property {string} [error]
 * @property {string} [signature]
 * @property {string | null} [dashboardId]
 * @property {string | null} [apiKeyId]
 */

/**
 * @param {RecordInput} input
 */
function recordWebhookDelivery(input) {
  try {
    let { dashboardId, apiKeyId } = input;
    if (!dashboardId && input.requestBody && typeof input.requestBody === 'object') {
      const orderId = /** @type {any} */ (input.requestBody).order_id;
      const derived = deriveContextFromOrder(orderId);
      dashboardId = derived.dashboardId;
      apiKeyId = apiKeyId ?? derived.apiKeyId;
    }
    if (!dashboardId) return; // unattributed deliveries don't get logged
    insertStmt.run({
      dashboard_id: dashboardId,
      api_key_id: apiKeyId ?? null,
      url: input.url,
      method: input.method ?? 'POST',
      request_body: safeStringify(input.requestBody),
      response_status: input.responseStatus ?? null,
      response_body: input.responseBody ?? null,
      latency_ms: input.latencyMs ?? null,
      error: input.error ?? null,
      signature: input.signature ?? null,
    });
  } catch (err) {
    console.error(
      `[webhook-log] failed to persist delivery: ${/** @type {Error} */ (err).message}`,
    );
  }
}

function safeStringify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 8000);
  try {
    return JSON.stringify(value).slice(0, 8000);
  } catch {
    return String(value).slice(0, 8000);
  }
}

/**
 * @param {string} dashboardId
 * @param {{ limit?: number; apiKeyId?: string }} [opts]
 */
function listDeliveries(dashboardId, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const conditions = ['dashboard_id = @dashboard_id'];
  /** @type {Record<string, unknown>} */
  const params = { dashboard_id: dashboardId, limit };
  if (opts.apiKeyId) {
    conditions.push('api_key_id = @api_key_id');
    params.api_key_id = opts.apiKeyId;
  }
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, dashboard_id, api_key_id, url, method, request_body,
                response_status, response_body, latency_ms, error, signature, created_at
         FROM webhook_deliveries
         WHERE ${conditions.join(' AND ')}
         ORDER BY id DESC LIMIT @limit`,
      )
      .all(params)
  ).map((r) => ({
    ...r,
    request_body: r.request_body ? safeParse(r.request_body) : null,
    response_body: r.response_body,
  }));
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

module.exports = {
  recordWebhookDelivery,
  listDeliveries,
};
