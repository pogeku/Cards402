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
