// Shared types for the dashboard. Mirrors the backend shape served by
// /dashboard/* endpoints. Kept separate from the page components so
// helpers and hooks can import them without pulling in React.

export type AgentStateName = 'minted' | 'initializing' | 'awaiting_funding' | 'funded' | 'active';

export interface AgentState {
  state: AgentStateName;
  label: string;
  detail: string | null;
  since: string | null;
  wallet_public_key: string | null;
}

export interface ApiKey {
  id: string;
  label: string | null;
  spend_limit_usdc: string | null;
  total_spent_usdc: string;
  default_webhook_url: string | null;
  wallet_public_key: string | null;
  enabled: number;
  suspended: number;
  last_used_at: string | null;
  created_at: string;
  policy_daily_limit_usdc: string | null;
  policy_single_tx_limit_usdc: string | null;
  policy_require_approval_above_usdc: string | null;
  policy_allowed_hours: string | null;
  policy_allowed_days: string | null;
  mode: 'live' | 'sandbox';
  rate_limit_rpm: number | null;
  expires_at: string | null;
  agent?: AgentState;
}

export interface Order {
  id: string;
  status: string;
  amount_usdc: string;
  payment_asset: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  stellar_txid: string | null;
  card_brand: string | null;
  api_key_id: string;
  api_key_label: string | null;
}

export interface ApprovalRequest {
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
  api_key_label: string | null;
}

export interface DashboardStats {
  total_orders: number;
  total_gmv: number;
  delivered: number;
  failed: number;
  refunded: number;
  pending: number;
  active_keys: number;
  pending_approvals: number;
}

export interface DashboardInfo {
  id: string;
  name: string;
  spend_limit_usdc: string | null;
  frozen: boolean;
  created_at: string;
  stats: DashboardStats;
}

export interface NewKeyData {
  id: string;
  key: string;
  webhook_secret: string;
  label: string | null;
  claim?: { code: string; expires_at: string; ttl_ms: number };
}

export interface User {
  id: string;
  email: string;
  role: string;
  // Deployment-level flag from CARDS402_PLATFORM_OWNER_EMAIL — controls
  // visibility of system-level alerts (CTX auth, fulfillment circuit
  // breaker) and other operator-only UI. Distinct from `role`, which
  // is dashboard-scoped.
  is_platform_owner?: boolean;
}

export interface WalletBalance {
  xlm: string;
  usdc: string;
}

export type SystemAlertKind = 'ctx_auth_dead' | 'circuit_breaker_frozen';
export type UserAlertKind = 'failure_rate_high' | 'spend_over' | 'agent_balance_low';
export type AlertKind = SystemAlertKind | UserAlertKind;

export const SYSTEM_ALERT_KINDS: ReadonlySet<AlertKind> = new Set([
  'ctx_auth_dead',
  'circuit_breaker_frozen',
]);

export function isSystemAlertKind(kind: string): kind is SystemAlertKind {
  return SYSTEM_ALERT_KINDS.has(kind as AlertKind);
}

export interface AlertRule {
  id: string;
  dashboard_id: string;
  name: string;
  kind: AlertKind;
  config: Record<string, unknown>;
  enabled: boolean;
  snoozed_until: string | null;
  notify_email: string | null;
  notify_webhook_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertFiring {
  id: number;
  rule_id: string;
  rule_name: string | null;
  kind: string | null;
  fired_at: string;
  context: Record<string, unknown>;
  notified: boolean;
}

export interface AuditLogEntry {
  id: number;
  dashboard_id: string;
  actor_user_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface EnabledMerchant {
  id: string;
  name: string;
  logo_url: string;
  card_image_url: string;
  country: string;
  currency: string;
  min_amount: number;
  max_amount: number;
  redeem_location: 'online' | 'in_store' | 'both';
  redeem_type: 'barcode' | 'code' | 'link';
  enabled: boolean;
  description: string;
}

export interface WebhookDelivery {
  id: number;
  dashboard_id: string;
  api_key_id: string | null;
  url: string;
  method: string;
  request_body: unknown;
  response_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  error: string | null;
  signature: string | null;
  created_at: string;
}

export const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const API_BASE = '/api/admin-proxy';
export const AUTH_BASE = '/api/auth';
