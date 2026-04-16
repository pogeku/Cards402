// Thin fetch helpers around the /api/admin-proxy and /api/auth routes.
// Centralised so error handling and types are consistent across pages.

import {
  API_BASE,
  AUTH_BASE,
  type ApiKey,
  type ApprovalRequest,
  type DashboardInfo,
  type NewKeyData,
  type Order,
  type User,
  type AlertRule,
  type AlertFiring,
  type AuditLogEntry,
  type EnabledMerchant,
  type WebhookDelivery,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.message || body?.error || '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch a list endpoint that may return either a bare array or a
 * wrapped object like `{ key: [...] }`. The cards402 backend has
 * historically used both shapes — `/dashboard/api-keys`,
 * `/dashboard/orders`, and `/dashboard/approval-requests` return bare
 * arrays, while every new Phase 3 endpoint wraps in an object.
 * Normalising here means consumers can trust the shape.
 */
async function jsonList<T>(res: Response, wrapperKey: string): Promise<T[]> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.message || body?.error || '';
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const wrapped = (body as Record<string, unknown>)[wrapperKey];
    if (Array.isArray(wrapped)) return wrapped as T[];
  }
  return [];
}

export async function fetchMe(): Promise<{ user: User }> {
  const res = await fetch(`${AUTH_BASE}/me`);
  return json(res);
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_BASE}/logout`, { method: 'POST' });
}

export async function fetchDashboard(): Promise<DashboardInfo> {
  return json(await fetch(`${API_BASE}/dashboard`));
}

export async function fetchAgents(): Promise<{ api_keys: ApiKey[] }> {
  const api_keys = await jsonList<ApiKey>(
    await fetch(`${API_BASE}/dashboard/api-keys`),
    'api_keys',
  );
  return { api_keys };
}

export async function fetchOrders(limit = 200): Promise<{ orders: Order[] }> {
  const orders = await jsonList<Order>(
    await fetch(`${API_BASE}/dashboard/orders?limit=${limit}`),
    'orders',
  );
  return { orders };
}

export async function fetchApprovals(): Promise<{ approval_requests: ApprovalRequest[] }> {
  const approval_requests = await jsonList<ApprovalRequest>(
    await fetch(`${API_BASE}/dashboard/approval-requests?status=pending`),
    'approval_requests',
  );
  return { approval_requests };
}

export async function createAgent(body: {
  label: string;
  spend_limit_usdc?: string | null;
}): Promise<NewKeyData> {
  return json(
    await fetch(`${API_BASE}/dashboard/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function updateAgent(
  id: string,
  body: Partial<Omit<ApiKey, 'id' | 'created_at' | 'agent'>>,
): Promise<ApiKey> {
  return json(
    await fetch(`${API_BASE}/dashboard/api-keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/dashboard/api-keys/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete agent failed: ${res.status}`);
}

export async function suspendAgent(id: string, suspend: boolean): Promise<void> {
  const path = suspend ? 'suspend' : 'unsuspend';
  const res = await fetch(`${API_BASE}/dashboard/api-keys/${id}/${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
}

export async function approveOrder(id: string, decision_note?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/dashboard/approval-requests/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision_note }),
  });
  if (!res.ok) throw new Error(`approve failed: ${res.status}`);
}

export async function rejectOrder(id: string, decision_note?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/dashboard/approval-requests/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision_note }),
  });
  if (!res.ok) throw new Error(`reject failed: ${res.status}`);
}

// ── Phase 3 endpoints ────────────────────────────────────────────────────────

export async function fetchMerchants(): Promise<{ merchants: EnabledMerchant[] }> {
  return json(await fetch(`${API_BASE}/dashboard/merchants`));
}

export async function fetchAlertRules(): Promise<{
  rules: AlertRule[];
  available_kinds: AlertRule['kind'][];
  is_platform_owner: boolean;
}> {
  return json(await fetch(`${API_BASE}/dashboard/alert-rules`));
}

export async function createAlertRule(body: {
  name: string;
  kind: AlertRule['kind'];
  config?: Record<string, unknown>;
  notify_email?: string | null;
  notify_webhook_url?: string | null;
}): Promise<{ rule: AlertRule }> {
  return json(
    await fetch(`${API_BASE}/dashboard/alert-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function updateAlertRule(
  id: string,
  body: Partial<Pick<AlertRule, 'name' | 'config' | 'enabled'>> & {
    snoozedUntil?: string | null;
    notify_email?: string | null;
    notify_webhook_url?: string | null;
  },
): Promise<{ rule: AlertRule }> {
  return json(
    await fetch(`${API_BASE}/dashboard/alert-rules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteAlertRule(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/dashboard/alert-rules/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete alert rule failed: ${res.status}`);
}

export async function fetchAlertFirings(limit = 50): Promise<{ firings: AlertFiring[] }> {
  return json(await fetch(`${API_BASE}/dashboard/alert-firings?limit=${limit}`));
}

export async function fetchAuditLog(
  opts: {
    limit?: number;
    offset?: number;
    action?: string;
    actor?: string;
  } = {},
): Promise<{ entries: AuditLogEntry[] }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.action) params.set('action', opts.action);
  if (opts.actor) params.set('actor', opts.actor);
  const q = params.toString();
  return json(await fetch(`${API_BASE}/dashboard/audit-log${q ? '?' + q : ''}`));
}

export async function fetchWebhookDeliveries(
  limit = 50,
): Promise<{ deliveries: WebhookDelivery[] }> {
  return json(await fetch(`${API_BASE}/dashboard/webhook-deliveries?limit=${limit}`));
}

export async function sendTestWebhook(body: {
  url: string;
  webhook_secret?: string;
}): Promise<{ ok: boolean; note?: string }> {
  return json(
    await fetch(`${API_BASE}/dashboard/webhook-deliveries/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchPlatformWallet(): Promise<{ public_key: string; network: string }> {
  return json(await fetch(`${API_BASE}/dashboard/platform-wallet`));
}

// ── Platform-owner cross-tenant endpoints ────────────────────────────────────
//
// These all hit /dashboard/platform/* on the backend. They return data
// across EVERY tenant and are gated by requirePlatformOwner on the
// backend — non-owner users see 403 and these fetches throw.

const PLATFORM_BASE = `${API_BASE}/dashboard/platform`;

export async function fetchPlatformOverview(): Promise<PlatformOverview> {
  return json(await fetch(`${PLATFORM_BASE}/overview`));
}

export async function fetchPlatformOrders(params?: {
  status?: string;
  dashboard_id?: string;
  api_key_id?: string;
  limit?: number;
}): Promise<PlatformOrder[]> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.dashboard_id) qs.set('dashboard_id', params.dashboard_id);
  if (params?.api_key_id) qs.set('api_key_id', params.api_key_id);
  if (params?.limit) qs.set('limit', String(params.limit));
  const url = `${PLATFORM_BASE}/orders${qs.toString() ? `?${qs}` : ''}`;
  return json(await fetch(url));
}

export async function fetchPlatformAgents(): Promise<PlatformAgent[]> {
  return json(await fetch(`${PLATFORM_BASE}/agents`));
}

export async function fetchPlatformUsers(): Promise<PlatformUser[]> {
  return json(await fetch(`${PLATFORM_BASE}/users`));
}

export async function fetchPlatformDashboards(): Promise<PlatformDashboard[]> {
  return json(await fetch(`${PLATFORM_BASE}/dashboards`));
}

export async function fetchPlatformTreasury(): Promise<PlatformTreasury> {
  return json(await fetch(`${PLATFORM_BASE}/treasury`));
}

export async function fetchPlatformWebhooks(): Promise<PlatformWebhooks> {
  return json(await fetch(`${PLATFORM_BASE}/webhooks`));
}

export async function fetchPlatformApprovals(): Promise<PlatformApproval[]> {
  return json(await fetch(`${PLATFORM_BASE}/approvals`));
}

export async function fetchPlatformUnmatchedPayments(): Promise<PlatformUnmatchedPayment[]> {
  return json(await fetch(`${PLATFORM_BASE}/unmatched-payments`));
}

export async function fetchPlatformPolicyDecisions(): Promise<PlatformPolicyDecision[]> {
  return json(await fetch(`${PLATFORM_BASE}/policy-decisions`));
}

export async function fetchPlatformAudit(): Promise<PlatformAuditEntry[]> {
  return json(await fetch(`${PLATFORM_BASE}/audit`));
}

export async function fetchPlatformHealth(): Promise<PlatformHealth> {
  return json(await fetch(`${PLATFORM_BASE}/health`));
}

export interface PlatformMarginOrder {
  id: string;
  amount_usdc: string;
  ctx_invoice_xlm: string | null;
  settlement_xlm_usd_rate: string | null;
  ctx_cost_usd: string | null;
  margin_usd: string | null;
  margin_pct: string | null;
  effective_discount_pct: string | null;
  has_cost_data: boolean;
  payment_asset: string | null;
  api_key_label: string | null;
  dashboard_name: string | null;
  created_at: string;
}

export interface PlatformMargins {
  summary: {
    total_revenue_usdc: number;
    revenue_with_cost_data_usdc: number;
    total_ctx_cost_usd: number;
    total_margin_usd: number;
    margin_pct: number | null;
    delivered_count: number;
    orders_with_cost_data: number;
    orders_without_cost_data: number;
  };
  orders: PlatformMarginOrder[];
}

export async function fetchPlatformMargins(limit = 200): Promise<PlatformMargins> {
  return json(await fetch(`${PLATFORM_BASE}/margins?limit=${limit}`));
}

export async function postPlatformUnfreeze(): Promise<{ ok: boolean; frozen: boolean }> {
  return json(
    await fetch(`${PLATFORM_BASE}/unfreeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// ── Platform response types ──────────────────────────────────────────────────

export interface PlatformOverview {
  counts: {
    dashboards: number;
    users: number;
    api_keys: number;
    active_agents: number;
    orders: number;
  };
  status_counts: { status: string; n: number }[];
  last_24h: {
    total: number;
    delivered: number;
    failed: number;
    refunded: number;
    refund_pending: number;
    expired: number;
    delivered_volume_usd: string;
    success_rate: number | null;
  };
  top_agents: {
    id: string;
    label: string | null;
    dashboard_id: string | null;
    dashboard_name: string | null;
    owner_email: string | null;
    total_spent_usdc: string;
    last_used_at: string | null;
    order_count: number;
  }[];
  watcher: {
    last_ledger: number | null;
    last_ledger_at: string | null;
    age_seconds: number | null;
    dead_letter_24h: number;
  };
  system: {
    frozen: boolean;
    consecutive_failures: number;
    webhooks_failed_permanent_24h: number;
    webhook_queue_pending: number;
    unmatched_payments: number;
    approvals_pending: number;
  };
  treasury: {
    public_key: string | null;
    xlm: string | null;
    usdc: string | null;
    error: string | null;
  };
  generated_at: string;
}

export interface PlatformOrder {
  id: string;
  status: string;
  amount_usdc: string;
  payment_asset: string | null;
  stellar_txid: string | null;
  sender_address: string | null;
  refund_stellar_txid: string | null;
  card_brand: string | null;
  error: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
  has_card: number;
  vcc_job_id: string | null;
  api_key_id: string | null;
  api_key_label: string | null;
  dashboard_id: string | null;
  dashboard_name: string | null;
  owner_email: string | null;
}

export interface PlatformAgent {
  id: string;
  label: string | null;
  key_prefix: string | null;
  enabled: number;
  suspended: number;
  mode: string;
  rate_limit_rpm: number | null;
  spend_limit_usdc: string | null;
  total_spent_usdc: string;
  policy_daily_limit_usdc: string | null;
  policy_single_tx_limit_usdc: string | null;
  policy_require_approval_above_usdc: string | null;
  wallet_public_key: string | null;
  default_webhook_url: string | null;
  agent_state: string | null;
  agent_state_at: string | null;
  agent_state_detail: string | null;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
  dashboard_id: string | null;
  dashboard_name: string | null;
  owner_email: string | null;
  owner_role: string | null;
  order_count: number;
  delivered_count: number;
  refunded_count: number;
}

export interface PlatformUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
  last_login_at: string | null;
  dashboard_id: string | null;
  dashboard_name: string | null;
  dashboard_frozen: number | null;
  agent_count: number;
  order_count: number;
  active_sessions: number;
}

export interface PlatformDashboard {
  id: string;
  name: string;
  frozen: number;
  spend_limit_usdc: string | null;
  created_at: string;
  owner_email: string | null;
  owner_user_id: string | null;
  owner_role: string | null;
  agent_count: number;
  order_count: number;
  orders_24h: number;
  delivered_volume_usd: number;
}

export interface PlatformTreasury {
  balance: {
    public_key: string | null;
    xlm: string | null;
    usdc: string | null;
    error: string | null;
  };
  outflows: {
    tx_hash: string;
    created_at: string;
    asset_type: string;
    asset_code: string;
    amount: string;
    to: string;
    type: string;
  }[];
}

export interface PlatformWebhooks {
  deliveries: {
    id: number;
    dashboard_id: string | null;
    api_key_id: string | null;
    url: string;
    method: string;
    response_status: number | null;
    latency_ms: number | null;
    error: string | null;
    created_at: string;
    api_key_label: string | null;
    dashboard_name: string | null;
    owner_email: string | null;
  }[];
  queue: {
    id: string;
    url: string;
    attempts: number;
    delivered: number;
    next_attempt: string;
    last_error: string | null;
    created_at: string;
  }[];
}

export interface PlatformApproval {
  id: string;
  api_key_id: string;
  order_id: string;
  amount_usdc: string;
  agent_note: string | null;
  status: string;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decision_note: string | null;
  decided_by: string | null;
  api_key_label: string | null;
  dashboard_id: string | null;
  dashboard_name: string | null;
  owner_email: string | null;
}

export interface PlatformUnmatchedPayment {
  id: string;
  stellar_txid: string;
  sender_address: string | null;
  payment_asset: string | null;
  amount_usdc: string | null;
  amount_xlm: string | null;
  claimed_order_id: string | null;
  reason: string;
  refund_stellar_txid: string | null;
  created_at: string;
}

export interface PlatformPolicyDecision {
  id: string;
  api_key_id: string;
  order_id: string | null;
  decision: string;
  rule: string;
  reason: string;
  amount_usdc: string | null;
  created_at: string;
  api_key_label: string | null;
  dashboard_name: string | null;
  owner_email: string | null;
}

export interface PlatformAuditEntry {
  id: number;
  dashboard_id: string;
  actor_email: string;
  actor_role: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip: string | null;
  created_at: string;
  dashboard_name: string | null;
}

export interface PlatformHealth {
  watcher: {
    last_ledger: number | null;
    last_ledger_at: string | null;
    age_seconds: number | null;
    healthy: boolean;
  };
  circuit_breaker: {
    frozen: boolean;
    consecutive_failures: number;
  };
  dead_letter: {
    total: number;
    last_24h: number;
    recent: { tx_hash: string; ledger: number; error: string; created_at: string }[];
  };
  webhook_backlog: {
    pending: number;
    failed_permanent_24h: number;
    total_deliveries_24h: number;
    failed_deliveries_24h: number;
  };
  unmatched_payments: number;
}
