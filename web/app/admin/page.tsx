'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

// All backend calls from the admin UI go through a Next.js route handler
// proxy so the Bearer token can stay in an HttpOnly cookie that JavaScript
// never sees. The proxy injects the Authorization header server-side.
const API_BASE = '/api/admin-proxy';
const AUTH_BASE = '/api/auth';

// ── Types ────────────────────────────────────────────────────────────────────

interface SystemState {
  frozen: string;
  consecutive_failures: string;
}

interface Stats {
  total_orders: number;
  total_gmv: number;
  delivered: number;
  failed: number;
  refunded: number;
  pending: number;
  refund_pending: number;
  active_keys: number;
}

interface Order {
  id: string;
  status: string;
  amount_usdc: string;
  payment_asset: string;
  error: string | null;
  created_at: string;
  stellar_txid: string | null;
  card_brand: string | null;
  api_key_label: string | null;
}

interface ApiKey {
  id: string;
  label: string | null;
  spend_limit_usdc: string | null;
  total_spent_usdc: string;
  default_webhook_url: string | null;
  wallet_public_key: string | null;
  enabled: number;
  suspended: number;
  created_at: string;
  last_used_at: string | null;
  policy_daily_limit_usdc: string | null;
  policy_single_tx_limit_usdc: string | null;
  policy_require_approval_above_usdc: string | null;
  policy_allowed_hours: string | null; // JSON: {"start":"HH:MM","end":"HH:MM"}
  policy_allowed_days: string | null; // JSON: [0..6]
  mode: 'live' | 'sandbox';
  rate_limit_rpm: number | null;
  expires_at: string | null;
}

interface ActivityPoint {
  day: string;
  count: number;
}

interface WalletBalance {
  xlm: string;
  usdc: string;
}

interface ApprovalRequest {
  id: string;
  api_key_id: string;
  api_key_label: string | null;
  order_id: string;
  amount_usdc: string;
  agent_note: string | null;
  status: string;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

interface PolicyDecision {
  id: string;
  api_key_id: string;
  api_key_label: string | null;
  order_id: string | null;
  decision: string;
  rule: string;
  reason: string;
  amount_usdc: string | null;
  created_at: string;
}

interface User {
  id: string;
  email: string;
  role: 'owner' | 'user';
  created_at: string;
  last_login_at: string | null;
}

interface WebhookEntry {
  id: string;
  url: string;
  attempts: number;
  next_attempt: string | null;
  last_error: string | null;
  delivered: number;
  created_at: string;
}

interface UnmatchedPayment {
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

interface DashboardTenant {
  id: string;
  name: string;
  owner_email: string;
  key_count: number;
  order_count: number;
  total_gmv: number;
  spend_limit_usdc: string | null;
  frozen: number;
  created_at: string;
}

// Session lives in an HttpOnly cookie set by /api/auth/verify. JS can't read
// or write it — all requests go through /api/admin-proxy which injects the
// backend Bearer server-side. The client tracks a boolean "logged in" flag
// derived from /api/auth/me.

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, n = 8) {
  if (!s) return '—';
  return s.slice(0, n) + '…';
}

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  delivered: { color: 'var(--green)', bg: 'var(--green-muted)', border: 'var(--green-border)' },
  refunded: { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)', border: 'rgba(96,165,250,0.3)' },
  failed: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  rejected: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  refund_pending: { color: '#fb923c', bg: 'rgba(251,146,60,0.1)', border: 'rgba(251,146,60,0.3)' },
  ordering: { color: '#facc15', bg: 'rgba(250,204,21,0.1)', border: 'rgba(250,204,21,0.3)' },
  pending_payment: { color: 'var(--muted)', bg: 'rgba(255,255,255,0.04)', border: 'var(--border)' },
  awaiting_approval: {
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.1)',
    border: 'rgba(167,139,250,0.3)',
  },
};

const DECISION_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  approved: { color: 'var(--green)', bg: 'var(--green-muted)', border: 'var(--green-border)' },
  blocked: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  pending_approval: {
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.1)',
    border: 'rgba(167,139,250,0.3)',
  },
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

async function fetchHorizonBalance(publicKey: string): Promise<WalletBalance | null> {
  try {
    const res = await fetch(`https://horizon.stellar.org/accounts/${publicKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    const balances: Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }> = data.balances ?? [];
    const xlm = balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    const usdc =
      balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER)?.balance ??
      '0';
    return { xlm: parseFloat(xlm).toFixed(4), usdc: parseFloat(usdc).toFixed(2) };
  } catch {
    return null;
  }
}

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? {
    color: 'var(--muted)',
    bg: 'transparent',
    border: 'var(--border)',
  };
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.7rem',
        padding: '0.2rem 0.55rem',
        borderRadius: 4,
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.color,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  const c = DECISION_COLORS[decision] ?? {
    color: 'var(--muted)',
    bg: 'transparent',
    border: 'var(--border)',
  };
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.7rem',
        padding: '0.2rem 0.55rem',
        borderRadius: 4,
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.color,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {decision}
    </span>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        marginBottom: '1.5rem',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function Btn({
  children,
  onClick,
  variant = 'default',
  disabled,
  small,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'green' | 'danger' | 'ghost' | 'purple';
  disabled?: boolean;
  small?: boolean;
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: {
      background: 'var(--surface-2)',
      color: 'var(--fg)',
      border: '1px solid var(--border)',
    },
    green: {
      background: 'var(--green)',
      color: '#000',
      border: '1px solid var(--green)',
      fontWeight: 700,
    },
    danger: {
      background: 'rgba(248,113,113,0.15)',
      color: '#f87171',
      border: '1px solid rgba(248,113,113,0.3)',
    },
    ghost: { background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)' },
    purple: {
      background: 'rgba(167,139,250,0.15)',
      color: '#a78bfa',
      border: '1px solid rgba(167,139,250,0.3)',
    },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        padding: small ? '0.3rem 0.75rem' : '0.5rem 1rem',
        borderRadius: 6,
        fontSize: small ? '0.75rem' : '0.875rem',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label
        style={{
          display: 'block',
          fontSize: '0.75rem',
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: '0.375rem',
        }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '0.5625rem 0.75rem',
          color: 'var(--fg)',
          fontSize: '0.9rem',
          fontFamily: 'inherit',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

// W-7: Webhook URL field with client-side validation (HTTPS only, no private IPs)
const PRIVATE_IP_RE =
  /^(127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function validateWebhookUrl(value: string): string | null {
  if (!value) return null; // blank is OK (optional field)
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return 'Must use HTTPS';
    const h = u.hostname;
    if (PRIVATE_IP_RE.test(h) || h === 'localhost' || h === '::1')
      return 'Private/local addresses not allowed';
    return null;
  } catch {
    return 'Invalid URL';
  }
}

function WebhookUrlInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const err = validateWebhookUrl(value);
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label
        style={{
          display: 'block',
          fontSize: '0.75rem',
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: '0.375rem',
        }}
      >
        Default webhook URL (optional)
      </label>
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://your-app.com/webhook"
        style={{
          width: '100%',
          background: 'var(--bg)',
          border: `1px solid ${err ? 'rgba(248,113,113,0.6)' : 'var(--border)'}`,
          borderRadius: 6,
          padding: '0.5625rem 0.75rem',
          color: 'var(--fg)',
          fontSize: '0.9rem',
          fontFamily: 'inherit',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {err && (
        <p
          style={{
            fontSize: '0.75rem',
            color: '#f87171',
            marginTop: '0.25rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {err}
        </p>
      )}
    </div>
  );
}

function AgentStatusDot({ apiKey }: { apiKey: ApiKey }) {
  if (apiKey.wallet_public_key) {
    return (
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
          fontSize: '0.72rem',
          color: 'var(--green)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--green)',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        Wallet ready
      </span>
    );
  }
  if (apiKey.last_used_at) {
    return (
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.375rem',
          fontSize: '0.72rem',
          color: '#facc15',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#facc15',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        Setting up wallet
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.375rem',
        fontSize: '0.72rem',
        color: '#fb923c',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: '#fb923c',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
      Awaiting connection
    </span>
  );
}

function SpendBar({ spent, limit }: { spent: string; limit: string | null }) {
  if (!limit)
    return (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>${spent} / ∞</span>
    );
  const pct = Math.min(100, (parseFloat(spent) / parseFloat(limit)) * 100);
  const color = pct > 90 ? '#f87171' : pct > 70 ? '#fb923c' : 'var(--green)';
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          color: 'var(--muted)',
          marginBottom: '0.25rem',
        }}
      >
        ${spent} / ${limit}
      </div>
      <div
        style={{
          height: 4,
          background: 'var(--border)',
          borderRadius: 2,
          width: 100,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: color,
            borderRadius: 2,
            transition: 'width 0.3s',
          }}
        />
      </div>
    </div>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({
  data,
  width = 80,
  height = 28,
}: {
  data: ActivityPoint[];
  width?: number;
  height?: number;
}) {
  if (!data || data.length === 0) return null;
  const counts = data.map((d) => d.count);
  const max = Math.max(...counts, 1);
  const pts = counts
    .map((c, i) => {
      const x = (i / (counts.length - 1)) * width;
      const y = height - (c / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div
      title={`${total} orders in last 7 days`}
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
    >
      <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
        <polyline
          points={pts}
          fill="none"
          stroke="var(--green)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.7"
        />
      </svg>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--muted)' }}>
        {total}
      </span>
    </div>
  );
}

// ── Stat cell ─────────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ padding: '1.25rem 1.5rem', borderRight: '1px solid var(--border)' }}>
      <div
        style={{
          fontSize: '0.7rem',
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
          marginBottom: '0.4rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.5rem',
          fontWeight: 700,
          color: color ?? 'var(--fg)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Edit Key Modal ────────────────────────────────────────────────────────────

function EditKeyModal({
  keyData,
  onClose,
  onSaved,
}: {
  keyData: ApiKey;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(keyData.label ?? '');
  const [limit, setLimit] = useState(keyData.spend_limit_usdc ?? '');
  const [webhook, setWebhook] = useState(keyData.default_webhook_url ?? '');
  const [walletKey, setWalletKey] = useState(keyData.wallet_public_key ?? '');
  const [dailyLimit, setDailyLimit] = useState(keyData.policy_daily_limit_usdc ?? '');
  const [singleTxLimit, setSingleTxLimit] = useState(keyData.policy_single_tx_limit_usdc ?? '');
  const [approvalThreshold, setApprovalThreshold] = useState(
    keyData.policy_require_approval_above_usdc ?? '',
  );
  const [mode, setMode] = useState<'live' | 'sandbox'>(keyData.mode ?? 'live');
  const [rateLimitRpm, setRateLimitRpm] = useState(
    keyData.rate_limit_rpm ? String(keyData.rate_limit_rpm) : '',
  );
  const [expiresAt, setExpiresAt] = useState(
    keyData.expires_at ? keyData.expires_at.slice(0, 16) : '',
  );

  // Parse allowed_hours JSON -> two time strings
  const parsedHours = keyData.policy_allowed_hours
    ? (() => {
        try {
          return JSON.parse(keyData.policy_allowed_hours!);
        } catch {
          return null;
        }
      })()
    : null;
  const [hoursStart, setHoursStart] = useState(parsedHours?.start ?? '');
  const [hoursEnd, setHoursEnd] = useState(parsedHours?.end ?? '');

  // Parse allowed_days JSON -> Set<number>
  const parsedDays: number[] = keyData.policy_allowed_days
    ? (() => {
        try {
          return JSON.parse(keyData.policy_allowed_days!);
        } catch {
          return [];
        }
      })()
    : [];
  const [allowedDays, setAllowedDays] = useState<Set<number>>(new Set(parsedDays));

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function toggleDay(d: number) {
    setAllowedDays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  async function save() {
    setLoading(true);
    setError('');
    try {
      const body: Record<string, string | null | boolean> = {};
      if (label !== (keyData.label ?? '')) body.label = label || null;
      if (limit !== (keyData.spend_limit_usdc ?? '')) body.spend_limit_usdc = limit || null;
      if (webhook !== (keyData.default_webhook_url ?? ''))
        body.default_webhook_url = webhook || null;
      if (walletKey !== (keyData.wallet_public_key ?? ''))
        body.wallet_public_key = walletKey || null;
      if (dailyLimit !== (keyData.policy_daily_limit_usdc ?? ''))
        body.policy_daily_limit_usdc = dailyLimit || null;
      if (singleTxLimit !== (keyData.policy_single_tx_limit_usdc ?? ''))
        body.policy_single_tx_limit_usdc = singleTxLimit || null;
      if (approvalThreshold !== (keyData.policy_require_approval_above_usdc ?? ''))
        body.policy_require_approval_above_usdc = approvalThreshold || null;

      // Allowed hours: only set if both or neither are provided
      const hoursChanged =
        hoursStart !== (parsedHours?.start ?? '') || hoursEnd !== (parsedHours?.end ?? '');
      if (hoursChanged) {
        body.policy_allowed_hours =
          hoursStart && hoursEnd ? JSON.stringify({ start: hoursStart, end: hoursEnd }) : null;
      }

      // Allowed days: compare sorted arrays
      const newDaysArr = Array.from(allowedDays).sort((a, b) => a - b);
      const oldDaysArr = [...parsedDays].sort((a, b) => a - b);
      const daysChanged = JSON.stringify(newDaysArr) !== JSON.stringify(oldDaysArr);
      if (daysChanged) {
        body.policy_allowed_days = newDaysArr.length > 0 ? JSON.stringify(newDaysArr) : null;
      }

      if (mode !== (keyData.mode ?? 'live')) body.mode = mode;
      if (rateLimitRpm !== (keyData.rate_limit_rpm ? String(keyData.rate_limit_rpm) : ''))
        body.rate_limit_rpm = rateLimitRpm || null;
      if (expiresAt !== (keyData.expires_at ? keyData.expires_at.slice(0, 16) : ''))
        body.expires_at = expiresAt || null;

      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }

      const res = await fetch(`${API_BASE}/admin/api-keys/${keyData.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.75rem',
    fontFamily: 'var(--font-mono)',
    color: 'var(--muted)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    fontWeight: 600,
    marginBottom: '0.375rem',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
        overflowY: 'auto',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          width: '100%',
          maxWidth: 460,
          margin: 'auto',
        }}
      >
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '1.5rem' }}>
          Edit API key
        </h2>

        <Input label="Label" value={label} onChange={setLabel} placeholder="my-agent" />
        <Input
          label="Spend limit USDC (blank = unlimited)"
          value={limit}
          onChange={setLimit}
          placeholder="100.00"
          type="number"
        />
        <WebhookUrlInput value={webhook} onChange={setWebhook} />
        <Input
          label="Agent Stellar wallet address (optional)"
          value={walletKey}
          onChange={setWalletKey}
          placeholder="G…"
        />

        <div
          style={{ borderTop: '1px solid var(--border)', marginBottom: '1rem', paddingTop: '1rem' }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 600,
              marginBottom: '0.75rem',
            }}
          >
            Spend controls
          </div>

          <Input
            label="Daily limit USDC (blank = none)"
            value={dailyLimit}
            onChange={setDailyLimit}
            placeholder="500.00"
            type="number"
          />
          <Input
            label="Per-transaction hard cap USDC (blank = none)"
            value={singleTxLimit}
            onChange={setSingleTxLimit}
            placeholder="200.00"
            type="number"
          />
          <Input
            label="Require approval above USDC (blank = none)"
            value={approvalThreshold}
            onChange={setApprovalThreshold}
            placeholder="50.00"
            type="number"
          />

          {/* Allowed hours */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={fieldLabelStyle}>Allowed hours UTC (blank = anytime)</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="time"
                value={hoursStart}
                onChange={(e) => setHoursStart(e.target.value)}
                style={{
                  flex: 1,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.5rem 0.75rem',
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.875rem',
                  outline: 'none',
                }}
              />
              <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>to</span>
              <input
                type="time"
                value={hoursEnd}
                onChange={(e) => setHoursEnd(e.target.value)}
                style={{
                  flex: 1,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.5rem 0.75rem',
                  color: 'var(--fg)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.875rem',
                  outline: 'none',
                }}
              />
            </div>
          </div>

          {/* Allowed days */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={fieldLabelStyle}>Allowed days (none checked = all days)</label>
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {DAY_NAMES.map((name, i) => (
                <button
                  key={i}
                  onClick={() => toggleDay(i)}
                  style={{
                    padding: '0.3rem 0.6rem',
                    borderRadius: 6,
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    border: '1px solid',
                    ...(allowedDays.has(i)
                      ? {
                          background: 'var(--green-muted)',
                          borderColor: 'var(--green-border)',
                          color: 'var(--green)',
                        }
                      : {
                          background: 'var(--bg)',
                          borderColor: 'var(--border)',
                          color: 'var(--muted)',
                        }),
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{ borderTop: '1px solid var(--border)', marginBottom: '1rem', paddingTop: '1rem' }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 600,
              marginBottom: '0.75rem',
            }}
          >
            Advanced
          </div>

          {/* Mode toggle */}
          <div style={{ marginBottom: '1rem' }}>
            <label style={fieldLabelStyle}>Mode</label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {(['live', 'sandbox'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: '0.35rem 0.9rem',
                    borderRadius: 6,
                    fontSize: '0.8rem',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    border: '1px solid',
                    ...(mode === m
                      ? m === 'sandbox'
                        ? {
                            background: 'rgba(251,146,60,0.15)',
                            borderColor: 'rgba(251,146,60,0.4)',
                            color: '#fb923c',
                          }
                        : {
                            background: 'var(--green-muted)',
                            borderColor: 'var(--green-border)',
                            color: 'var(--green)',
                          }
                      : {
                          background: 'var(--bg)',
                          borderColor: 'var(--border)',
                          color: 'var(--muted)',
                        }),
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            {mode === 'sandbox' && (
              <p
                style={{
                  fontSize: '0.72rem',
                  color: '#fb923c',
                  marginTop: '0.3rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Sandbox: orders return fake cards instantly, no Stellar payment required.
              </p>
            )}
          </div>

          <Input
            label="Rate limit (orders/min, blank = default 1/min)"
            value={rateLimitRpm}
            onChange={setRateLimitRpm}
            placeholder="10"
            type="number"
          />
          <div style={{ marginBottom: '1rem' }}>
            <label style={fieldLabelStyle}>Key expires at (blank = never)</label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '0.5625rem 0.75rem',
                color: 'var(--fg)',
                fontSize: '0.9rem',
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {error && (
          <p
            style={{
              color: '#f87171',
              fontSize: '0.875rem',
              marginBottom: '1rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.625rem' }}>
          <Btn variant="green" onClick={save} disabled={loading}>
            {loading ? 'Saving…' : 'Save changes'}
          </Btn>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ── Create API Key Modal ──────────────────────────────────────────────────────

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [label, setLabel] = useState('');
  const [limit, setLimit] = useState('');
  const [webhook, setWebhook] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ key: string; webhook_secret: string } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const agentPrompt = result
    ? `Read https://cards402.com/skill.md and set up this agent with:\nkey: ${result.key}\napi_url: ${API_BASE}`
    : '';

  async function create() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label || undefined,
          spend_limit_usdc: limit || undefined,
          default_webhook_url: webhook || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setResult({ key: data.key, webhook_secret: data.webhook_secret });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  function copyPrompt() {
    navigator.clipboard?.writeText(agentPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function maskSecret(s: string): string {
    // Show prefix (cards402_) + 4 chars + dots + last 4 chars
    const prefix = s.startsWith('cards402_') ? 'cards402_' : '';
    const rest = s.slice(prefix.length);
    return `${prefix}${rest.slice(0, 4)}${'•'.repeat(Math.max(0, rest.length - 8))}${rest.slice(-4)}`;
  }

  function revealKey() {
    setKeyRevealed(true);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => setKeyRevealed(false), 30_000);
  }

  function revealSecret() {
    setSecretRevealed(true);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => setSecretRevealed(false), 30_000);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
        overflowY: 'auto',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          width: '100%',
          maxWidth: 520,
          margin: 'auto',
        }}
      >
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '1.5rem' }}>
          Create API key
        </h2>

        {result ? (
          <div>
            {/* ── Credentials ── */}
            <div
              style={{
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                marginBottom: '0.375rem',
              }}
            >
              API Key — copy now, not shown again
            </div>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                marginBottom: '1rem',
                alignItems: 'stretch',
              }}
            >
              <div
                style={{
                  flex: 1,
                  background: 'var(--bg)',
                  border: '1px solid var(--green-border)',
                  borderRadius: 8,
                  padding: '0.75rem 1rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8rem',
                  color: 'var(--green)',
                  wordBreak: 'break-all',
                  cursor: 'copy',
                }}
                onClick={() => navigator.clipboard?.writeText(result.key)}
              >
                {keyRevealed ? result.key : maskSecret(result.key)}
              </div>
              <button
                onClick={keyRevealed ? () => setKeyRevealed(false) : revealKey}
                style={{
                  flexShrink: 0,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '0 0.75rem',
                  fontSize: '0.75rem',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {keyRevealed ? 'Hide' : 'Reveal'}
              </button>
            </div>

            <div
              style={{
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                marginBottom: '0.375rem',
              }}
            >
              Webhook Secret
            </div>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                marginBottom: '1.5rem',
                alignItems: 'stretch',
              }}
            >
              <div
                style={{
                  flex: 1,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '0.75rem 1rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8rem',
                  color: 'var(--fg)',
                  wordBreak: 'break-all',
                  cursor: 'copy',
                }}
                onClick={() => navigator.clipboard?.writeText(result.webhook_secret)}
              >
                {secretRevealed ? result.webhook_secret : maskSecret(result.webhook_secret)}
              </div>
              <button
                onClick={secretRevealed ? () => setSecretRevealed(false) : revealSecret}
                style={{
                  flexShrink: 0,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '0 0.75rem',
                  fontSize: '0.75rem',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {secretRevealed ? 'Hide' : 'Reveal'}
              </button>
            </div>

            {/* ── Agent onboarding ── */}
            <div
              style={{
                background: 'rgba(96,165,250,0.06)',
                border: '1px solid rgba(96,165,250,0.2)',
                borderRadius: 10,
                padding: '1.25rem',
                marginBottom: '1.5rem',
              }}
            >
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                Connect your agent
              </div>
              <p
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--muted)',
                  marginBottom: '1rem',
                  lineHeight: 1.6,
                }}
              >
                Send this to your agent. It will read the skill file, set up its wallet, and appear
                in your dashboard automatically.
              </p>
              <div
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '0.875rem 1rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem',
                  color: 'var(--fg)',
                  whiteSpace: 'pre',
                  marginBottom: '0.75rem',
                  overflowX: 'auto',
                  lineHeight: 1.7,
                }}
              >
                {agentPrompt}
              </div>
              <Btn small variant="ghost" onClick={copyPrompt}>
                {copied ? 'Copied!' : 'Copy prompt'}
              </Btn>
            </div>

            <Btn onClick={onCreated} variant="green">
              Done
            </Btn>
          </div>
        ) : (
          <div>
            <Input label="Label" value={label} onChange={setLabel} placeholder="my-agent" />
            <Input
              label="Spend limit USDC (optional)"
              value={limit}
              onChange={setLimit}
              placeholder="100.00"
              type="number"
            />
            <WebhookUrlInput value={webhook} onChange={setWebhook} />
            {error && (
              <p
                style={{
                  color: '#f87171',
                  fontSize: '0.875rem',
                  marginBottom: '1rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <Btn variant="green" onClick={create} disabled={loading}>
                {loading ? 'Creating…' : 'Create key'}
              </Btn>
              <Btn variant="ghost" onClick={onClose}>
                Cancel
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Approval decision modal ───────────────────────────────────────────────────

function ApprovalModal({
  approval,
  onClose,
  onDone,
}: {
  approval: ApprovalRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);

  async function decide(action: 'approve' | 'reject') {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/approval-requests/${approval.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setPendingAction(null);
    } finally {
      setLoading(false);
    }
  }

  const expiresAt = new Date(approval.expires_at);
  const minutesLeft = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 60000));

  // ── Confirmation step ─────────────────────────────────────────────────────
  if (pendingAction) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
          padding: '1rem',
        }}
        onClick={(e) => e.target === e.currentTarget && !loading && setPendingAction(null)}
      >
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '2rem',
            width: '100%',
            maxWidth: 380,
          }}
        >
          <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.75rem' }}>
            Confirm {pendingAction === 'approve' ? 'approval' : 'rejection'}
          </h2>
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--muted)',
              marginBottom: '1.5rem',
              lineHeight: 1.6,
            }}
          >
            {pendingAction === 'approve'
              ? `Approve $${approval.amount_usdc} for ${approval.api_key_label ?? approval.api_key_id.slice(0, 12)}? This will immediately trigger card fulfillment.`
              : `Reject this request? The agent will receive a rejection and the order will not proceed.`}
          </p>
          {error && (
            <p
              style={{
                color: '#f87171',
                fontSize: '0.875rem',
                marginBottom: '1rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.625rem' }}>
            <Btn
              variant={pendingAction === 'approve' ? 'green' : 'danger'}
              onClick={() => decide(pendingAction)}
              disabled={loading}
            >
              {loading ? 'Processing…' : `Yes, ${pendingAction}`}
            </Btn>
            <Btn variant="ghost" onClick={() => setPendingAction(null)} disabled={loading}>
              Back
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          width: '100%',
          maxWidth: 440,
        }}
      >
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Review approval request
        </h2>
        <p
          style={{
            fontSize: '0.8rem',
            color: 'var(--muted)',
            marginBottom: '1.5rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Expires in {minutesLeft}m · {expiresAt.toLocaleString()}
        </p>

        <div
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '1rem',
            marginBottom: '1.25rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span
              style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
            >
              Agent
            </span>
            <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>
              {approval.api_key_label ?? approval.api_key_id.slice(0, 12)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span
              style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
            >
              Amount
            </span>
            <span
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                color: 'var(--green)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              ${approval.amount_usdc}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span
              style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
            >
              Order
            </span>
            <span
              style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}
            >
              {approval.order_id.slice(0, 16)}…
            </span>
          </div>
          {approval.agent_note && (
            <div
              style={{
                marginTop: '0.75rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  fontSize: '0.7rem',
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 600,
                  marginBottom: '0.3rem',
                }}
              >
                Agent note
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--fg)', lineHeight: 1.5, margin: 0 }}>
                {approval.agent_note}
              </p>
            </div>
          )}
        </div>

        <Input
          label="Decision note (optional)"
          value={note}
          onChange={setNote}
          placeholder="Approved for quarterly SaaS renewal"
        />

        {error && (
          <p
            style={{
              color: '#f87171',
              fontSize: '0.875rem',
              marginBottom: '1rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.625rem' }}>
          <Btn variant="green" onClick={() => setPendingAction('approve')} disabled={loading}>
            Approve
          </Btn>
          <Btn variant="danger" onClick={() => setPendingAction('reject')} disabled={loading}>
            Reject
          </Btn>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ── Main Admin Component ──────────────────────────────────────────────────────

// ── Inactivity timeout constants (W-8) ────────────────────────────────────────
const INACTIVITY_WARN_MS = 25 * 60 * 1000; // warn after 25 min idle
const INACTIVITY_LOGOUT_MS = 30 * 60 * 1000; // logout after 30 min idle

// Audit A-28: tiny hook that wraps an async action to show loading + disable
// the button until the action completes. Returns [isLoading, wrappedFn].
function useAction<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): [boolean, (...args: T) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const wrapped = useCallback(
    async (...args: T) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn(...args);
      } finally {
        setBusy(false);
      }
    },
    [fn, busy],
  );
  return [busy, wrapped];
}

export default function AdminPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Auth state
  // `authed` is a boolean flag derived from /api/auth/me — the actual
  // backend token lives in an HttpOnly cookie that the client never reads.
  const [authed, setAuthed] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loginStep, setLoginStep] = useState<'email' | 'code'>('email');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [users, setUsers] = useState<User[]>([]);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [filterKey, setFilterKey] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [decidedApprovals, setDecidedApprovals] = useState<ApprovalRequest[]>([]);
  const [policyDecisions, setPolicyDecisions] = useState<PolicyDecision[]>([]);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [walletBalances, setWalletBalances] = useState<Record<string, WalletBalance | null>>({});

  const [dashboardTenants, setDashboardTenants] = useState<DashboardTenant[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
  const [unmatchedPayments, setUnmatchedPayments] = useState<UnmatchedPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [reviewingApproval, setReviewingApproval] = useState<ApprovalRequest | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Activity sparklines per key
  const [keyActivity, setKeyActivity] = useState<Record<string, ActivityPoint[]>>({});
  // Rotation modal
  const [rotatingKey, setRotatingKey] = useState<ApiKey | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  // Webhook test status per key
  const [webhookTestStatus, setWebhookTestStatus] = useState<
    Record<string, 'idle' | 'loading' | 'ok' | 'error'>
  >({});
  // Order search filters — seeded from URL search params (audit A-40) so a
  // browser refresh preserves the operator's current view.
  const [orderSearch, setOrderSearch] = useState(searchParams?.get('q') || '');
  const [orderFrom, setOrderFrom] = useState(searchParams?.get('from') || '');
  const [orderTo, setOrderTo] = useState(searchParams?.get('to') || '');

  // Sync filter state to URL so refresh preserves the view.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (orderSearch) params.set('q', orderSearch);
    if (orderFrom) params.set('from', orderFrom);
    if (orderTo) params.set('to', orderTo);
    if (filterKey) params.set('key', filterKey);
    const qs = params.toString();
    const target = qs ? `${pathname}?${qs}` : pathname;
    if (target !== `${pathname}${window.location.search}`) {
      router.replace(target, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderSearch, orderFrom, orderTo, filterKey]);

  // Inactivity timeout (W-8)
  const lastActivity = useRef(Date.now());
  const [showIdleWarning, setShowIdleWarning] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState(0);

  // OTP send cooldown (W-10)
  const [codeCooldown, setCodeCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const headers: HeadersInit = {};
      const keyParam = filterKey ? `&api_key_id=${filterKey}` : '';
      const searchParam = orderSearch ? `&search=${encodeURIComponent(orderSearch)}` : '';
      const fromParam = orderFrom ? `&from=${orderFrom}` : '';
      const toParam = orderTo ? `&to=${orderTo}` : '';
      const [sysRes, statsRes, ordRes, keyRes, whRes, appRes, decidedRes, dashRes, unmatchedRes] =
        await Promise.all([
          fetch(`${API_BASE}/admin/system`, { headers }),
          fetch(`${API_BASE}/admin/stats`, { headers }),
          fetch(
            `${API_BASE}/admin/orders?limit=200${keyParam}${searchParam}${fromParam}${toParam}`,
            { headers },
          ),
          fetch(`${API_BASE}/admin/api-keys`, { headers }),
          fetch(`${API_BASE}/admin/webhooks`, { headers }),
          fetch(`${API_BASE}/admin/approval-requests?status=pending&limit=100`, { headers }),
          fetch(`${API_BASE}/admin/approval-requests?status=approved&limit=20`, { headers }),
          fetch(`${API_BASE}/admin/dashboards`, { headers }),
          fetch(`${API_BASE}/admin/unmatched-payments`, { headers }),
        ]);

      if (sysRes.status === 401) {
        setError('Session expired. Please sign in again.');
        return;
      }

      const [
        sysData,
        statsData,
        ordData,
        keyData,
        whData,
        appData,
        decidedData,
        dashData,
        unmatchedData,
      ] = await Promise.all([
        sysRes.json(),
        statsRes.json(),
        ordRes.json(),
        keyRes.json(),
        whRes.json(),
        appRes.json(),
        decidedRes.json(),
        dashRes.json(),
        unmatchedRes.json(),
      ]);

      setSystem(sysData);
      setStats(statsData);
      setOrders(ordData);
      setApiKeys(keyData);
      setWebhooks(whData);
      setApprovals(Array.isArray(appData) ? appData : []);
      setDecidedApprovals(Array.isArray(decidedData) ? decidedData : []);
      setDashboardTenants(Array.isArray(dashData) ? dashData : []);
      setUnmatchedPayments(Array.isArray(unmatchedData) ? unmatchedData : []);
    } catch {
      setError('Could not reach backend. Is it running?');
    } finally {
      setLoading(false);
    }
  }, [filterKey, orderSearch, orderFrom, orderTo]);

  const fetchAuditLog = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/policy-decisions?limit=100`);
      const data = await res.json();
      setPolicyDecisions(Array.isArray(data) ? data : []);
    } catch {
      /* non-critical */
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/users`);
      const data = await res.json();
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      /* non-critical */
    }
  }, []);

  // Fetch 7-day activity sparkline data for all keys
  const fetchActivity = useCallback(async () => {
    if (apiKeys.length === 0) return;
    const results = await Promise.all(
      apiKeys.map((k) =>
        fetch(`${API_BASE}/admin/api-keys/${k.id}/activity`)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ),
    );
    const map: Record<string, ActivityPoint[]> = {};
    apiKeys.forEach((k, i) => {
      map[k.id] = results[i];
    });
    setKeyActivity(map);
  }, [apiKeys]);

  useEffect(() => {
    if (authed && apiKeys.length > 0) fetchActivity();
  }, [authed, apiKeys, fetchActivity]);

  async function testWebhook(keyId: string) {
    setWebhookTestStatus((prev) => ({ ...prev, [keyId]: 'loading' }));
    try {
      const res = await fetch(`${API_BASE}/admin/api-keys/${keyId}/test-webhook`, {
        method: 'POST',
        headers: {},
      });
      setWebhookTestStatus((prev) => ({ ...prev, [keyId]: res.ok ? 'ok' : 'error' }));
      setTimeout(() => setWebhookTestStatus((prev) => ({ ...prev, [keyId]: 'idle' })), 3000);
    } catch {
      setWebhookTestStatus((prev) => ({ ...prev, [keyId]: 'error' }));
      setTimeout(() => setWebhookTestStatus((prev) => ({ ...prev, [keyId]: 'idle' })), 3000);
    }
  }

  async function rotateKey(key: ApiKey) {
    setRotatingKey(key);
    setRotatedKey(null);
  }

  async function confirmRotate() {
    if (!rotatingKey) return;
    try {
      const res = await fetch(`${API_BASE}/admin/api-keys/${rotatingKey.id}/rotate`, {
        method: 'POST',
        headers: {},
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Rotation failed');
      setRotatedKey(data.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rotation failed');
      setRotatingKey(null);
    }
  }

  async function retryWebhook(id: string) {
    const res = await fetch(`${API_BASE}/admin/webhooks/${id}/retry`, {
      method: 'POST',
      headers: {},
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.message ?? `Retry failed (${res.status})`);
      return;
    }
    fetchAll();
  }

  function downloadOrdersCsv() {
    const keyParam = filterKey ? `&api_key_id=${filterKey}` : '';
    const searchParam = orderSearch ? `&search=${encodeURIComponent(orderSearch)}` : '';
    const fromParam = orderFrom ? `&from=${orderFrom}` : '';
    const toParam = orderTo ? `&to=${orderTo}` : '';
    const url = `${API_BASE}/admin/orders?format=csv&limit=5000${keyParam}${searchParam}${fromParam}${toParam}`;
    fetch(url, { headers: {} })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `orders-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
  }

  // ── Restore session on mount (W-6) ───────────────────────────────────────
  // /api/auth/me validates the HttpOnly session cookie on the server and
  // returns the current user. 401 means the cookie is missing, tampered,
  // or expired — fall through to the login wall.
  useEffect(() => {
    fetch(`${AUTH_BASE}/me`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (data.user?.role !== 'owner') {
          // Non-owners belong on their per-tenant dashboard
          fetch(`${AUTH_BASE}/logout`, { method: 'POST' }).catch(() => {});
          router.push('/dashboard');
          return;
        }
        setAuthed(true);
        setCurrentUser(data.user);
      })
      .catch(() => {
        /* not logged in — login wall renders */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Inactivity timeout (W-8) ─────────────────────────────────────────────
  useEffect(() => {
    if (!authed) return;

    function resetActivity() {
      lastActivity.current = Date.now();
    }
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => document.addEventListener(e, resetActivity, { passive: true }));

    const interval = setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= INACTIVITY_LOGOUT_MS) {
        logout();
      } else if (idle >= INACTIVITY_WARN_MS) {
        const secondsLeft = Math.ceil((INACTIVITY_LOGOUT_MS - idle) / 1000);
        setIdleSecondsLeft(secondsLeft);
        setShowIdleWarning(true);
      } else {
        setShowIdleWarning(false);
      }
    }, 10_000); // check every 10s

    return () => {
      events.forEach((e) => document.removeEventListener(e, resetActivity));
      clearInterval(interval);
    };
  }, [authed]);

  useEffect(() => {
    if (authed) {
      fetchAll();
      fetchUsers();
    }
  }, [authed, fetchAll, fetchUsers]);

  useEffect(() => {
    if (showAuditLog && authed) fetchAuditLog();
  }, [showAuditLog, authed, fetchAuditLog]);

  // Fetch live Stellar balances for any key that has a wallet_public_key
  useEffect(() => {
    const keysWithWallet = apiKeys.filter((k) => k.wallet_public_key);
    if (keysWithWallet.length === 0) return;
    // Mark all as loading
    setWalletBalances((prev) => {
      const next = { ...prev };
      for (const k of keysWithWallet) next[k.id] = prev[k.id] ?? null;
      return next;
    });
    for (const k of keysWithWallet) {
      fetchHorizonBalance(k.wallet_public_key!).then((bal) => {
        setWalletBalances((prev) => ({ ...prev, [k.id]: bal }));
      });
    }
  }, [apiKeys]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    if (autoRefresh && authed) {
      refreshTimer.current = setInterval(fetchAll, 30_000);
    }
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [autoRefresh, authed, fetchAll]);

  async function sendCode() {
    if (!loginEmail.trim() || codeCooldown > 0) return;
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${AUTH_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to send code');
      setLoginStep('code');
      // W-10: 60-second cooldown after sending to reflect backend rate limit
      setCodeCooldown(60);
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
      cooldownTimer.current = setInterval(() => {
        setCodeCooldown((n) => {
          if (n <= 1) {
            clearInterval(cooldownTimer.current!);
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoginLoading(false);
    }
  }

  async function verifyCode() {
    if (!loginCode.trim()) return;
    setLoginLoading(true);
    setLoginError('');
    try {
      // /api/auth/verify forwards the code to the backend and, on success,
      // wraps the returned token in an HttpOnly cookie server-side. The
      // browser only sees the user object.
      const res = await fetch(`${AUTH_BASE}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim(), code: loginCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Invalid code');
      // Non-owners belong in /dashboard, not /admin (super-admin)
      if (data.user?.role !== 'owner') {
        router.push('/dashboard');
        return;
      }
      setAuthed(true);
      setCurrentUser(data.user);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoginLoading(false);
    }
  }

  async function logout() {
    // Route handler clears the HttpOnly cookie and notifies the backend.
    await fetch(`${AUTH_BASE}/logout`, { method: 'POST' }).catch(() => {});
    setAuthed(false);
    setCurrentUser(null);
    setSystem(null);
    setStats(null);
    setOrders([]);
    setApiKeys([]);
    setApprovals([]);
    setDecidedApprovals([]);
    setPolicyDecisions([]);
    setWalletBalances({});
    setUsers([]);
    setLoginStep('email');
    setLoginCode('');
    setLoginError('');
    setShowIdleWarning(false);
    setKeyActivity({});
    setRotatingKey(null);
    setRotatedKey(null);
    setWebhookTestStatus({});
    setOrderSearch('');
    setOrderFrom('');
    setOrderTo('');
    setUnmatchedPayments([]);
  }

  // Audit A-28: wrap destructive ops with useAction so the button is disabled
  // during the async call, preventing double-clicks.
  const [unfreezing, unfreezeAction] = useAction(async () => {
    const res = await fetch(`${API_BASE}/admin/system/unfreeze`, { method: 'POST', headers: {} });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Unfreeze failed (${res.status})`);
      return;
    }
    fetchAll();
  });
  const unfreeze = unfreezeAction;

  async function toggleKey(id: string, enabled: number) {
    const res = await fetch(`${API_BASE}/admin/api-keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Update failed (${res.status})`);
      return;
    }
    fetchAll();
  }

  const [suspending, suspendKeyAction] = useAction(async (id: string, suspended: number) => {
    const action = suspended ? 'unsuspend' : 'suspend';
    const res = await fetch(`${API_BASE}/admin/api-keys/${id}/${action}`, {
      method: 'POST',
      headers: {},
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `${action} failed (${res.status})`);
      return;
    }
    fetchAll();
  });
  const suspendKey = suspendKeyAction;

  const [refunding, refundOrderAction] = useAction(async (id: string) => {
    if (!confirm(`Queue refund for order ${id.slice(0, 8)}…?`)) return;
    const res = await fetch(`${API_BASE}/admin/orders/${id}/refund`, {
      method: 'POST',
      headers: {},
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? `Refund failed (${res.status})`);
      return;
    }
    fetchAll();
  });
  const refundOrder = refundOrderAction;

  function downloadAuditCsv() {
    const url = `${API_BASE}/admin/policy-decisions?format=csv`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'policy-decisions.csv';
    // Add auth header via fetch + blob since <a href> can't set headers
    fetch(url, { headers: {} })
      .then((r) => r.blob())
      .then((blob) => {
        a.href = URL.createObjectURL(blob);
        a.click();
        URL.revokeObjectURL(a.href);
      });
  }

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');

  // ── Idle warning modal (W-8) ──────────────────────────────────────────────
  const idleWarningModal = showIdleWarning && (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid rgba(251,146,60,0.4)',
          borderRadius: 12,
          padding: '2rem',
          width: '100%',
          maxWidth: 380,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>⏱</div>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Still there?
        </h2>
        <p
          style={{
            fontSize: '0.875rem',
            color: 'var(--muted)',
            marginBottom: '1.5rem',
            lineHeight: 1.6,
          }}
        >
          You&apos;ll be signed out in{' '}
          <strong style={{ color: '#fb923c' }}>{idleSecondsLeft}s</strong> due to inactivity.
        </p>
        <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'center' }}>
          <Btn
            variant="green"
            onClick={() => {
              lastActivity.current = Date.now();
              setShowIdleWarning(false);
            }}
          >
            Stay signed in
          </Btn>
          <Btn variant="ghost" onClick={logout}>
            Sign out now
          </Btn>
        </div>
      </div>
    </div>
  );

  // ── Key rotation modal ────────────────────────────────────────────────────
  const rotationModal = rotatingKey && (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          width: '100%',
          maxWidth: 480,
        }}
      >
        {rotatedKey ? (
          <>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              New API key generated
            </h2>
            <p
              style={{
                fontSize: '0.875rem',
                color: '#f87171',
                marginBottom: '1rem',
                fontFamily: 'var(--font-mono)',
              }}
            >
              The old key is immediately invalid. Copy the new key now — it will not be shown again.
            </p>
            <div
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--green-border)',
                borderRadius: 8,
                padding: '0.875rem 1rem',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                color: 'var(--green)',
                wordBreak: 'break-all',
                cursor: 'copy',
                marginBottom: '1.5rem',
              }}
              onClick={() => navigator.clipboard?.writeText(rotatedKey)}
            >
              {rotatedKey}
            </div>
            <Btn
              variant="green"
              onClick={() => {
                setRotatingKey(null);
                setRotatedKey(null);
                fetchAll();
              }}
            >
              Done
            </Btn>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              Rotate API key
            </h2>
            <p
              style={{
                fontSize: '0.875rem',
                color: 'var(--muted)',
                marginBottom: '1.5rem',
                lineHeight: 1.6,
              }}
            >
              A new secret will be generated for{' '}
              <strong>{rotatingKey.label ?? rotatingKey.id.slice(0, 12)}</strong>. The existing key
              stops working immediately — update all consumers before rotating.
            </p>
            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <Btn variant="danger" onClick={confirmRotate}>
                Rotate now
              </Btn>
              <Btn variant="ghost" onClick={() => setRotatingKey(null)}>
                Cancel
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // ── Login ─────────────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <div
        className="dot-grid"
        style={{
          minHeight: '80vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '2.5rem',
            width: '100%',
            maxWidth: 380,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              color: 'var(--green)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: '1rem',
            }}
          >
            Admin
          </div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, marginBottom: '1.75rem' }}>
            {loginStep === 'email' ? 'Sign in' : 'Check your email'}
          </h1>

          {loginStep === 'email' ? (
            <>
              <Input
                label="Email"
                value={loginEmail}
                onChange={setLoginEmail}
                placeholder="you@example.com"
                type="email"
              />
              {loginError && (
                <p
                  style={{
                    color: '#f87171',
                    fontSize: '0.875rem',
                    marginBottom: '1rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {loginError}
                </p>
              )}
              <Btn
                variant="green"
                onClick={sendCode}
                disabled={loginLoading || !loginEmail.trim() || codeCooldown > 0}
              >
                {loginLoading
                  ? 'Sending…'
                  : codeCooldown > 0
                    ? `Resend in ${codeCooldown}s`
                    : 'Send code'}
              </Btn>
            </>
          ) : (
            <>
              <p
                style={{
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                  marginBottom: '1.25rem',
                  lineHeight: 1.6,
                }}
              >
                We sent a 6-digit code to <strong>{loginEmail}</strong>.
              </p>
              <Input
                label="Login code"
                value={loginCode}
                onChange={setLoginCode}
                placeholder="123456"
                type="text"
              />
              {loginError && (
                <p
                  style={{
                    color: '#f87171',
                    fontSize: '0.875rem',
                    marginBottom: '1rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {loginError}
                </p>
              )}
              <div style={{ display: 'flex', gap: '0.625rem' }}>
                <Btn
                  variant="green"
                  onClick={verifyCode}
                  disabled={loginLoading || !loginCode.trim()}
                >
                  {loginLoading ? 'Verifying…' : 'Verify'}
                </Btn>
                <Btn
                  variant="ghost"
                  onClick={() => {
                    setLoginStep('email');
                    setLoginCode('');
                    setLoginError('');
                  }}
                >
                  Back
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  return (
    <>
      {idleWarningModal}
      {rotationModal}
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '2.5rem 1.5rem 6rem' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '2rem',
            flexWrap: 'wrap',
            gap: '0.75rem',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.7rem',
                color: 'var(--green)',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                marginBottom: '0.25rem',
              }}
            >
              Admin
            </div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Dashboard</h1>
          </div>
          <div style={{ display: 'flex', gap: '0.625rem', alignItems: 'center' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.8rem',
                color: 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh 30s
            </label>
            <Btn onClick={fetchAll} disabled={loading} variant="ghost" small>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Btn>
            <a
              href="/dashboard"
              style={{
                fontSize: '0.8rem',
                color: 'var(--muted)',
                textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
              }}
            >
              My dashboard
            </a>
            {currentUser && (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {currentUser.email}
                {currentUser.role === 'owner' && (
                  <span style={{ color: 'var(--green)', marginLeft: '0.35rem' }}>owner</span>
                )}
              </span>
            )}
            <Btn onClick={logout} variant="ghost" small>
              Sign out
            </Btn>
          </div>
        </div>

        {error && (
          <div
            style={{
              background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.25)',
              borderRadius: 8,
              padding: '0.875rem 1.125rem',
              color: '#f87171',
              fontSize: '0.875rem',
              fontFamily: 'var(--font-mono)',
              marginBottom: '1.5rem',
            }}
          >
            {error}
          </div>
        )}

        {/* Stats bar */}
        {stats && (
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              marginBottom: '1.5rem',
              display: 'flex',
              flexWrap: 'wrap',
              overflow: 'hidden',
            }}
          >
            <Stat label="Total GMV" value={`$${stats.total_gmv.toFixed(2)}`} color="var(--green)" />
            <Stat label="Orders" value={stats.total_orders} />
            <Stat label="Delivered" value={stats.delivered} color="var(--green)" />
            <Stat
              label="Failed"
              value={stats.failed}
              color={stats.failed > 0 ? '#f87171' : undefined}
            />
            <Stat
              label="Refunded"
              value={stats.refunded}
              color={stats.refunded > 0 ? '#60a5fa' : undefined}
            />
            <Stat
              label="Pending approvals"
              value={pendingApprovals.length}
              color={pendingApprovals.length > 0 ? '#a78bfa' : undefined}
            />
            <div
              style={{
                padding: '1.25rem 1.5rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                flexGrow: 1,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: system?.frozen === '1' ? '#f87171' : 'var(--green)',
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                {system?.frozen === '1' ? 'FROZEN' : 'System OK'}
              </span>
              {system?.frozen === '1' && (
                <Btn variant="green" small onClick={unfreeze} disabled={unfreezing}>
                  {unfreezing ? 'Unfreezing…' : 'Unfreeze'}
                </Btn>
              )}
              {system && system.frozen !== '1' && parseInt(system.consecutive_failures) > 0 && (
                <span
                  style={{ fontSize: '0.75rem', color: '#fb923c', fontFamily: 'var(--font-mono)' }}
                >
                  {system.consecutive_failures} consecutive failure(s)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Approval queue — shown when there are pending requests */}
        {pendingApprovals.length > 0 && (
          <div
            style={{
              background: 'rgba(167,139,250,0.06)',
              border: '1px solid rgba(167,139,250,0.3)',
              borderRadius: 12,
              marginBottom: '1.5rem',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '1rem 1.25rem',
                borderBottom: '1px solid rgba(167,139,250,0.2)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.625rem',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#a78bfa',
                  display: 'inline-block',
                  flexShrink: 0,
                  boxShadow: '0 0 6px #a78bfa',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: '0.9375rem', color: '#a78bfa' }}>
                Approval queue ({pendingApprovals.length})
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Amount</th>
                    <th>Note</th>
                    <th>Requested</th>
                    <th>Expires</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pendingApprovals.map((a) => {
                    const expiresAt = new Date(a.expires_at);
                    const minutesLeft = Math.max(
                      0,
                      Math.floor((expiresAt.getTime() - Date.now()) / 60000),
                    );
                    const urgent = minutesLeft < 30;
                    return (
                      <tr key={a.id}>
                        <td style={{ fontWeight: 500 }}>
                          {a.api_key_label ?? (
                            <span style={{ color: 'var(--muted)' }}>
                              {a.api_key_id.slice(0, 12)}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            color: 'var(--green)',
                          }}
                        >
                          ${a.amount_usdc}
                        </td>
                        <td
                          style={{
                            fontSize: '0.8rem',
                            color: 'var(--muted)',
                            maxWidth: 200,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={a.agent_note ?? ''}
                        >
                          {a.agent_note ?? '—'}
                        </td>
                        <td
                          style={{
                            color: 'var(--muted)',
                            fontSize: '0.75rem',
                            fontFamily: 'var(--font-mono)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {new Date(a.requested_at).toLocaleString()}
                        </td>
                        <td
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.75rem',
                            color: urgent ? '#f87171' : 'var(--muted)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {minutesLeft}m
                        </td>
                        <td>
                          <Btn small variant="purple" onClick={() => setReviewingApproval(a)}>
                            Review
                          </Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent approval decisions — audit trail (W-14) */}
        {decidedApprovals.length > 0 && (
          <Card title="Recent approval decisions">
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Decided by</th>
                    <th>Decided at</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {decidedApprovals.map((a) => (
                    <tr key={a.id}>
                      <td style={{ fontWeight: 500 }}>
                        {a.api_key_label ?? (
                          <span style={{ color: 'var(--muted)' }}>{a.api_key_id.slice(0, 12)}</span>
                        )}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.9rem',
                          fontWeight: 700,
                          color: 'var(--green)',
                        }}
                      >
                        ${a.amount_usdc}
                      </td>
                      <td>
                        <DecisionBadge
                          decision={a.status === 'approved' ? 'approved' : 'blocked'}
                        />
                      </td>
                      <td
                        style={{
                          fontSize: '0.8rem',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--muted)',
                        }}
                      >
                        {a.decided_by ?? '—'}
                      </td>
                      <td
                        style={{
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--muted)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.decided_at ? new Date(a.decided_at).toLocaleString() : '—'}
                      </td>
                      <td
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--muted)',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={a.decision_note ?? ''}
                      >
                        {a.decision_note ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Dashboards (tenants) */}
        <Card title={`Dashboards (${dashboardTenants.length})`}>
          <div style={{ overflowX: 'auto' }}>
            {dashboardTenants.length === 0 ? (
              <div
                style={{
                  padding: '2rem',
                  textAlign: 'center',
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                }}
              >
                No dashboards yet.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Name</th>
                    <th>Agents</th>
                    <th>Orders</th>
                    <th>GMV</th>
                    <th>Status</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboardTenants.map((d) => (
                    <tr key={d.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
                        {d.owner_email}
                      </td>
                      <td style={{ fontWeight: 500 }}>{d.name}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
                        {d.key_count}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
                        {d.order_count}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 600,
                          color: 'var(--green)',
                        }}
                      >
                        ${Number(d.total_gmv).toFixed(2)}
                      </td>
                      <td>
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            color: d.frozen ? '#f87171' : 'var(--green)',
                          }}
                        >
                          {d.frozen ? 'frozen' : 'active'}
                        </span>
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {new Date(d.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* Orders */}
        <Card
          title={`Orders (${orders.length})`}
          action={
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="Search ID or label…"
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.25rem 0.5rem',
                  color: 'var(--fg)',
                  fontSize: '0.8rem',
                  fontFamily: 'var(--font-mono)',
                  width: 160,
                }}
              />
              <input
                type="date"
                value={orderFrom}
                onChange={(e) => setOrderFrom(e.target.value)}
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.25rem 0.5rem',
                  color: 'var(--fg)',
                  fontSize: '0.8rem',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <input
                type="date"
                value={orderTo}
                onChange={(e) => setOrderTo(e.target.value)}
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.25rem 0.5rem',
                  color: 'var(--fg)',
                  fontSize: '0.8rem',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <select
                value={filterKey}
                onChange={(e) => setFilterKey(e.target.value)}
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.25rem 0.5rem',
                  color: 'var(--fg)',
                  fontSize: '0.8rem',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <option value="">All keys</option>
                {apiKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label ?? k.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <Btn small variant="ghost" onClick={downloadOrdersCsv}>
                CSV
              </Btn>
            </div>
          }
        >
          <div style={{ overflowX: 'auto' }}>
            {orders.length === 0 ? (
              <div
                style={{
                  padding: '2rem',
                  textAlign: 'center',
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                }}
              >
                No orders yet.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>Status</th>
                    <th>Amount</th>
                    <th>Asset</th>
                    <th>Agent</th>
                    <th>Brand</th>
                    <th>Created</th>
                    <th>Error</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <span
                          title={order.id}
                          onClick={() => navigator.clipboard?.writeText(order.id)}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.75rem',
                            color: 'var(--muted)',
                            cursor: 'copy',
                          }}
                        >
                          {truncate(order.id, 12)}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={order.status} />
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
                        ${order.amount_usdc}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.75rem',
                          color: 'var(--muted)',
                          textTransform: 'uppercase',
                        }}
                      >
                        {order.payment_asset ?? 'usdc'}
                      </td>
                      <td style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>
                        {order.api_key_label ?? '—'}
                      </td>
                      <td style={{ color: 'var(--muted)', fontSize: '0.8125rem' }}>
                        {order.card_brand ?? '—'}
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {new Date(order.created_at).toLocaleString()}
                      </td>
                      <td
                        style={{
                          color: '#f87171',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          maxWidth: 180,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={order.error ?? ''}
                      >
                        {order.error ?? '—'}
                      </td>
                      <td>
                        {order.status === 'failed' && (
                          <Btn
                            small
                            variant="ghost"
                            onClick={() => refundOrder(order.id)}
                            disabled={refunding}
                          >
                            {refunding ? '…' : 'Refund'}
                          </Btn>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* API Keys */}
        <Card title={`API keys (${apiKeys.length})`}>
          <div style={{ overflowX: 'auto' }}>
            {apiKeys.length === 0 ? (
              <div
                style={{
                  padding: '2rem',
                  textAlign: 'center',
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                }}
              >
                No API keys yet.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Spend</th>
                    <th>Activity</th>
                    <th>Wallet</th>
                    <th>Agent</th>
                    <th>Policy</th>
                    <th>Mode</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map((key) => {
                    const policies: string[] = [];
                    if (key.policy_daily_limit_usdc)
                      policies.push(`$${key.policy_daily_limit_usdc}/day`);
                    if (key.policy_single_tx_limit_usdc)
                      policies.push(`≤$${key.policy_single_tx_limit_usdc}/tx`);
                    if (key.policy_require_approval_above_usdc)
                      policies.push(`approval >$${key.policy_require_approval_above_usdc}`);
                    if (key.policy_allowed_hours) {
                      try {
                        const { start, end } = JSON.parse(key.policy_allowed_hours);
                        policies.push(`${start}–${end} UTC`);
                      } catch {
                        /* ignore */
                      }
                    }
                    if (key.policy_allowed_days) {
                      try {
                        const days: number[] = JSON.parse(key.policy_allowed_days);
                        policies.push(days.map((d) => DAY_NAMES[d]).join('/'));
                      } catch {
                        /* ignore */
                      }
                    }

                    return (
                      <tr key={key.id}>
                        <td style={{ fontWeight: 500 }}>
                          {key.label ?? <span style={{ color: 'var(--muted)' }}>unlabeled</span>}
                          {key.expires_at && new Date(key.expires_at) > new Date() && (
                            <div
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--muted)',
                                marginTop: '0.15rem',
                              }}
                            >
                              expires {new Date(key.expires_at).toLocaleDateString()}
                            </div>
                          )}
                          {key.expires_at && new Date(key.expires_at) <= new Date() && (
                            <div
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: '#f87171',
                                marginTop: '0.15rem',
                              }}
                            >
                              expired
                            </div>
                          )}
                        </td>
                        <td>
                          <SpendBar
                            spent={key.total_spent_usdc || '0'}
                            limit={key.spend_limit_usdc}
                          />
                        </td>
                        <td>
                          <Sparkline data={keyActivity[key.id] ?? []} />
                        </td>
                        <td style={{ minWidth: 140 }}>
                          {key.wallet_public_key ? (
                            <div>
                              <div
                                title={key.wallet_public_key}
                                onClick={() =>
                                  navigator.clipboard?.writeText(key.wallet_public_key!)
                                }
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: '0.7rem',
                                  color: 'var(--muted)',
                                  cursor: 'copy',
                                  marginBottom: '0.25rem',
                                }}
                              >
                                {key.wallet_public_key.slice(0, 6)}…
                                {key.wallet_public_key.slice(-4)}
                              </div>
                              {walletBalances[key.id] ? (
                                <div
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.72rem',
                                    display: 'flex',
                                    gap: '0.5rem',
                                  }}
                                >
                                  <span style={{ color: 'var(--green)' }}>
                                    {walletBalances[key.id]!.usdc} USDC
                                  </span>
                                  <span style={{ color: 'var(--muted)' }}>
                                    {walletBalances[key.id]!.xlm} XLM
                                  </span>
                                </div>
                              ) : (
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: '0.7rem',
                                    color: 'var(--muted)',
                                    opacity: 0.5,
                                  }}
                                >
                                  loading…
                                </span>
                              )}
                            </div>
                          ) : (
                            <span
                              style={{ color: 'var(--muted)', opacity: 0.4, fontSize: '0.8rem' }}
                            >
                              —
                            </span>
                          )}
                        </td>
                        <td style={{ minWidth: 130 }}>
                          <AgentStatusDot apiKey={key} />
                        </td>
                        <td
                          style={{
                            fontSize: '0.72rem',
                            color: 'var(--muted)',
                            fontFamily: 'var(--font-mono)',
                            maxWidth: 200,
                          }}
                        >
                          {policies.length > 0 ? (
                            policies.join(' · ')
                          ) : (
                            <span style={{ opacity: 0.4 }}>none</span>
                          )}
                          {key.rate_limit_rpm && (
                            <div style={{ marginTop: '0.15rem', color: '#60a5fa' }}>
                              {key.rate_limit_rpm}rpm
                            </div>
                          )}
                        </td>
                        <td>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.65rem',
                              padding: '0.15rem 0.45rem',
                              borderRadius: 4,
                              border: '1px solid',
                              fontWeight: 600,
                              ...(key.mode === 'sandbox'
                                ? {
                                    color: '#fb923c',
                                    background: 'rgba(251,146,60,0.1)',
                                    borderColor: 'rgba(251,146,60,0.3)',
                                  }
                                : {
                                    color: 'var(--muted)',
                                    background: 'transparent',
                                    borderColor: 'var(--border)',
                                  }),
                            }}
                          >
                            {key.mode ?? 'live'}
                          </span>
                        </td>
                        <td
                          style={{
                            color: 'var(--muted)',
                            fontSize: '0.75rem',
                            fontFamily: 'var(--font-mono)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {new Date(key.created_at).toLocaleDateString()}
                        </td>
                        <td>
                          {key.suspended ? (
                            <span
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.7rem',
                                padding: '0.2rem 0.55rem',
                                borderRadius: 4,
                                border: '1px solid rgba(248,113,113,0.3)',
                                background: 'rgba(248,113,113,0.1)',
                                color: '#f87171',
                                fontWeight: 600,
                              }}
                            >
                              suspended
                            </span>
                          ) : (
                            <span
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.7rem',
                                padding: '0.2rem 0.55rem',
                                borderRadius: 4,
                                border: '1px solid',
                                fontWeight: 600,
                                ...(key.enabled
                                  ? {
                                      color: 'var(--green)',
                                      background: 'var(--green-muted)',
                                      borderColor: 'var(--green-border)',
                                    }
                                  : {
                                      color: 'var(--muted)',
                                      background: 'rgba(255,255,255,0.04)',
                                      borderColor: 'var(--border)',
                                    }),
                              }}
                            >
                              {key.enabled ? 'enabled' : 'disabled'}
                            </span>
                          )}
                        </td>
                        <td style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <Btn small variant="ghost" onClick={() => setEditingKey(key)}>
                            Edit
                          </Btn>
                          <Btn
                            small
                            variant={key.enabled ? 'danger' : 'ghost'}
                            onClick={() => toggleKey(key.id, key.enabled)}
                          >
                            {key.enabled ? 'Disable' : 'Enable'}
                          </Btn>
                          <Btn
                            small
                            variant={key.suspended ? 'ghost' : 'danger'}
                            onClick={() => suspendKey(key.id, key.suspended)}
                            disabled={suspending}
                          >
                            {suspending ? '…' : key.suspended ? 'Unsuspend' : 'Suspend'}
                          </Btn>
                          <Btn small variant="ghost" onClick={() => rotateKey(key)}>
                            Rotate
                          </Btn>
                          {key.default_webhook_url && (
                            <Btn
                              small
                              variant={
                                webhookTestStatus[key.id] === 'ok'
                                  ? 'green'
                                  : webhookTestStatus[key.id] === 'error'
                                    ? 'danger'
                                    : 'ghost'
                              }
                              onClick={() => testWebhook(key.id)}
                              disabled={webhookTestStatus[key.id] === 'loading'}
                            >
                              {webhookTestStatus[key.id] === 'loading'
                                ? '…'
                                : webhookTestStatus[key.id] === 'ok'
                                  ? 'OK'
                                  : webhookTestStatus[key.id] === 'error'
                                    ? 'Failed'
                                    : 'Test '}
                            </Btn>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid var(--border)' }}>
            <Btn variant="green" onClick={() => setShowCreateModal(true)}>
              + Create API key
            </Btn>
          </div>
        </Card>

        {/* Audit log */}
        <Card
          title="Audit log"
          action={
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <Btn
                small
                variant="ghost"
                onClick={() => {
                  setShowAuditLog((v) => !v);
                }}
              >
                {showAuditLog ? 'Hide' : 'Show'}
              </Btn>
              <Btn small variant="ghost" onClick={downloadAuditCsv}>
                Export CSV
              </Btn>
            </div>
          }
        >
          {showAuditLog ? (
            <div style={{ overflowX: 'auto' }}>
              {policyDecisions.length === 0 ? (
                <div
                  style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    fontSize: '0.875rem',
                  }}
                >
                  No policy decisions recorded yet.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Decision</th>
                      <th>Rule</th>
                      <th>Agent</th>
                      <th>Amount</th>
                      <th>Reason</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policyDecisions.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <DecisionBadge decision={d.decision} />
                        </td>
                        <td
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.72rem',
                            color: 'var(--muted)',
                          }}
                        >
                          {d.rule}
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>
                          {d.api_key_label ?? d.api_key_id.slice(0, 12)}
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                          {d.amount_usdc ? `$${d.amount_usdc}` : '—'}
                        </td>
                        <td
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--muted)',
                            maxWidth: 280,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={d.reason}
                        >
                          {d.reason}
                        </td>
                        <td
                          style={{
                            color: 'var(--muted)',
                            fontSize: '0.72rem',
                            fontFamily: 'var(--font-mono)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {new Date(d.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <div style={{ padding: '1rem 1.25rem', color: 'var(--muted)', fontSize: '0.8125rem' }}>
              Full policy decision history. Click Show to view or Export CSV for a spreadsheet.
            </div>
          )}
        </Card>

        {/* Team */}
        <Card
          title={`Team (${users.length})`}
          action={
            <Btn small variant="ghost" onClick={fetchUsers}>
              Refresh
            </Btn>
          }
        >
          <div style={{ overflowX: 'auto' }}>
            {users.length === 0 ? (
              <div
                style={{
                  padding: '2rem',
                  textAlign: 'center',
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                }}
              >
                No users yet.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th>Last login</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                        {u.email}
                      </td>
                      <td>
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.7rem',
                            padding: '0.2rem 0.55rem',
                            borderRadius: 4,
                            border: '1px solid',
                            fontWeight: 600,
                            ...(u.role === 'owner'
                              ? {
                                  color: 'var(--green)',
                                  background: 'var(--green-muted)',
                                  borderColor: 'var(--green-border)',
                                }
                              : {
                                  color: 'var(--muted)',
                                  background: 'rgba(255,255,255,0.04)',
                                  borderColor: 'var(--border)',
                                }),
                          }}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.75rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                      </td>
                      <td style={{ display: 'flex', gap: '0.4rem' }}>
                        {currentUser?.role === 'owner' &&
                          u.id !== currentUser.id &&
                          u.role !== 'owner' && (
                            <>
                              <Btn
                                small
                                variant="ghost"
                                onClick={async () => {
                                  if (!confirm(`Transfer ownership to ${u.email}?`)) return;
                                  await fetch(
                                    `${API_BASE}/admin/users/${u.id}/transfer-ownership`,
                                    {
                                      method: 'POST',
                                      headers: {},
                                    },
                                  );
                                  fetchUsers();
                                }}
                              >
                                Make owner
                              </Btn>
                              <Btn
                                small
                                variant="danger"
                                onClick={async () => {
                                  if (!confirm(`Remove ${u.email}?`)) return;
                                  await fetch(`${API_BASE}/admin/users/${u.id}`, {
                                    method: 'DELETE',
                                    headers: {},
                                  });
                                  fetchUsers();
                                }}
                              >
                                Remove
                              </Btn>
                            </>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div
            style={{
              padding: '1rem 1.25rem',
              borderTop: '1px solid var(--border)',
              fontSize: '0.8rem',
              color: 'var(--muted)',
              lineHeight: 1.5,
            }}
          >
            Team members can log in with their email at this URL. First-time users are created
            automatically on first login.
          </div>
        </Card>

        {/* Webhook queue */}
        {webhooks.length > 0 && (
          <Card title={`Webhook queue (${webhooks.filter((w) => !w.delivered).length} pending)`}>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Attempts</th>
                    <th>Status</th>
                    <th>Next retry</th>
                    <th>Last error</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((wh) => (
                    <tr key={wh.id}>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.72rem',
                          color: 'var(--muted)',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={wh.url}
                      >
                        {wh.url}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.8rem',
                          textAlign: 'center',
                        }}
                      >
                        {wh.attempts}
                      </td>
                      <td>
                        {wh.delivered ? (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: 'var(--green)',
                              background: 'var(--green-muted)',
                              border: '1px solid var(--green-border)',
                              borderRadius: 4,
                              padding: '0.15rem 0.45rem',
                              fontWeight: 600,
                            }}
                          >
                            delivered
                          </span>
                        ) : wh.attempts >= 3 ? (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: '#f87171',
                              background: 'rgba(248,113,113,0.1)',
                              border: '1px solid rgba(248,113,113,0.3)',
                              borderRadius: 4,
                              padding: '0.15rem 0.45rem',
                              fontWeight: 600,
                            }}
                          >
                            failed
                          </span>
                        ) : (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: '#fb923c',
                              background: 'rgba(251,146,60,0.1)',
                              border: '1px solid rgba(251,146,60,0.3)',
                              borderRadius: 4,
                              padding: '0.15rem 0.45rem',
                              fontWeight: 600,
                            }}
                          >
                            pending
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.72rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {wh.next_attempt && !wh.delivered
                          ? new Date(wh.next_attempt).toLocaleString()
                          : '—'}
                      </td>
                      <td
                        style={{
                          color: '#f87171',
                          fontSize: '0.72rem',
                          fontFamily: 'var(--font-mono)',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={wh.last_error ?? ''}
                      >
                        {wh.last_error ?? '—'}
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.72rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {new Date(wh.created_at).toLocaleString()}
                      </td>
                      <td>
                        {!wh.delivered && (
                          <Btn small variant="ghost" onClick={() => retryWebhook(wh.id)}>
                            Retry
                          </Btn>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Unmatched payments — payments that arrived but couldn't be matched to an order */}
        {unmatchedPayments.length > 0 && (
          <Card
            title={`Unmatched payments (${unmatchedPayments.filter((p) => !p.refund_stellar_txid).length} unresolved)`}
          >
            <div
              style={{
                padding: '0.75rem 1.25rem',
                background: 'rgba(248,113,113,0.06)',
                borderBottom: '1px solid var(--border)',
                fontSize: '0.8rem',
                color: '#f87171',
                fontFamily: 'var(--font-mono)',
              }}
            >
              These payments arrived on-chain but could not be matched to a pending order. Each
              requires manual review and refund.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Txid</th>
                    <th>Sender</th>
                    <th>Amount</th>
                    <th>Claimed order</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedPayments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span
                          title={p.stellar_txid}
                          onClick={() => navigator.clipboard?.writeText(p.stellar_txid)}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.72rem',
                            color: 'var(--muted)',
                            cursor: 'copy',
                          }}
                        >
                          {p.stellar_txid.slice(0, 12)}…
                        </span>
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.72rem',
                          color: 'var(--muted)',
                        }}
                      >
                        {p.sender_address
                          ? `${p.sender_address.slice(0, 6)}…${p.sender_address.slice(-4)}`
                          : '—'}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.8rem',
                          fontWeight: 600,
                          color: '#f87171',
                        }}
                      >
                        {p.amount_usdc
                          ? `$${p.amount_usdc}`
                          : p.amount_xlm
                            ? `${p.amount_xlm} XLM`
                            : '—'}
                      </td>
                      <td
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.72rem',
                          color: 'var(--muted)',
                        }}
                      >
                        {p.claimed_order_id ? truncate(p.claimed_order_id, 12) : '—'}
                      </td>
                      <td
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--muted)',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={p.reason}
                      >
                        {p.reason}
                      </td>
                      <td>
                        {p.refund_stellar_txid ? (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: 'var(--green)',
                              fontWeight: 600,
                            }}
                          >
                            refunded
                          </span>
                        ) : (
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: '#f87171',
                              fontWeight: 600,
                            }}
                          >
                            needs refund
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          color: 'var(--muted)',
                          fontSize: '0.72rem',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {new Date(p.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {showCreateModal && (
          <CreateKeyModal
            onClose={() => setShowCreateModal(false)}
            onCreated={() => {
              setShowCreateModal(false);
              fetchAll();
            }}
          />
        )}

        {editingKey && (
          <EditKeyModal
            keyData={editingKey}
            onClose={() => setEditingKey(null)}
            onSaved={() => {
              setEditingKey(null);
              fetchAll();
            }}
          />
        )}

        {reviewingApproval && (
          <ApprovalModal
            approval={reviewingApproval}
            onClose={() => setReviewingApproval(null)}
            onDone={() => {
              setReviewingApproval(null);
              fetchAll();
            }}
          />
        )}
      </div>
    </>
  );
}
