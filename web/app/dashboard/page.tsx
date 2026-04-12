'use client';

// Per-user dashboard — manage your agents (API keys), view orders, handle approvals.
// Authenticated via email login code → session Bearer token.

import { useState, useEffect, useCallback } from 'react';

// All backend calls go through /api/admin-proxy so the Bearer token stays in
// an HttpOnly cookie (see web/app/api/admin-proxy/[...path]/route.ts).
const API_BASE = '/api/admin-proxy';
const AUTH_BASE = '/api/auth';

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
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
}

interface Order {
  id: string;
  status: string;
  amount_usdc: string;
  payment_asset: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  stellar_txid: string | null;
  card_brand: string | null;
  api_key_label: string | null;
}

interface ApprovalRequest {
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

interface Stats {
  total_orders: number;
  total_gmv: number;
  delivered: number;
  failed: number;
  refunded: number;
  pending: number;
  active_keys: number;
}

interface DashboardInfo {
  id: string;
  name: string;
  spend_limit_usdc: string | null;
  frozen: boolean;
  created_at: string;
  stats: Stats & { pending_approvals: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  delivered: { color: 'var(--green)', bg: 'var(--green-muted)', border: 'var(--green-border)' },
  refunded: { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)', border: 'rgba(96,165,250,0.3)' },
  failed: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  rejected: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  refund_pending: { color: '#fb923c', bg: 'rgba(251,146,60,0.1)', border: 'rgba(251,146,60,0.3)' },
  ordering: { color: '#facc15', bg: 'rgba(250,204,21,0.1)', border: 'rgba(250,204,21,0.3)' },
  pending_payment: { color: 'var(--muted)', bg: 'rgba(255,255,255,0.04)', border: 'var(--border)' },
};

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

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
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
      {sub && (
        <div
          style={{
            fontSize: '0.7rem',
            color: 'var(--muted)',
            marginTop: '0.25rem',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '0.5rem 0.75rem',
  color: 'var(--fg)',
  fontSize: '0.875rem',
  fontFamily: 'var(--font-mono)',
  boxSizing: 'border-box',
};

const btnStyle = (variant: 'primary' | 'danger' | 'ghost' = 'primary'): React.CSSProperties => ({
  padding: '0.5rem 1rem',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: '0.875rem',
  cursor: 'pointer',
  border: 'none',
  background:
    variant === 'primary' ? 'var(--green)' : variant === 'danger' ? '#ef4444' : 'var(--surface)',
  color: variant === 'primary' ? '#000' : variant === 'danger' ? '#fff' : 'var(--fg)',
  ...(variant === 'ghost' ? { border: '1px solid var(--border)' } : {}),
});

// ── Create Key Modal ─────────────────────────────────────────────────────────

function CreateKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: {
    key: string;
    webhook_secret: string;
    id: string;
    label: string | null;
  }) => void;
}) {
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setErr('');
    const body: Record<string, string | null> = { label: label || null };
    const res = await fetch(`${API_BASE}/dashboard/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setErr(d.message || d.error || 'Failed');
      return;
    }
    const data = await res.json();
    onCreated(data);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          width: 480,
          maxWidth: '90vw',
        }}
      >
        <h3 style={{ marginBottom: '1.5rem', fontWeight: 700, fontSize: '1.0625rem' }}>
          New Agent API Key
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Label
            </label>
            <input
              style={inputStyle}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. research-bot-1"
            />
          </div>
          {err && <p style={{ color: '#f87171', fontSize: '0.8125rem', margin: 0 }}>{err}</p>}
        </div>
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            marginTop: '1.5rem',
            justifyContent: 'flex-end',
          }}
        >
          <button style={btnStyle('ghost')} onClick={onClose}>
            Cancel
          </button>
          <button style={btnStyle('primary')} onClick={submit} disabled={saving}>
            {saving ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Key Modal ───────────────────────────────────────────────────────────

function EditKeyModal({
  keyData,
  onClose,
  onSaved,
}: {
  keyData: ApiKey;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(keyData.label || '');
  const [spendLimit, setSpendLimit] = useState(keyData.spend_limit_usdc || '');
  const [webhookUrl, setWebhookUrl] = useState(keyData.default_webhook_url || '');
  const [walletKey, setWalletKey] = useState(keyData.wallet_public_key || '');
  const [approvalAbove, setApprovalAbove] = useState(
    keyData.policy_require_approval_above_usdc || '',
  );
  const [dailyLimit, setDailyLimit] = useState(keyData.policy_daily_limit_usdc || '');
  const [txLimit, setTxLimit] = useState(keyData.policy_single_tx_limit_usdc || '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setErr('');
    const res = await fetch(`${API_BASE}/dashboard/api-keys/${keyData.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: label || null,
        spend_limit_usdc: spendLimit || null,
        default_webhook_url: webhookUrl || null,
        wallet_public_key: walletKey || null,
        policy_require_approval_above_usdc: approvalAbove || null,
        policy_daily_limit_usdc: dailyLimit || null,
        policy_single_tx_limit_usdc: txLimit || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setErr(d.message || d.error || 'Failed');
      return;
    }
    onSaved();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          width: 480,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ marginBottom: '1.5rem', fontWeight: 700, fontSize: '1.0625rem' }}>
          Edit Agent Key
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Label
            </label>
            <input style={inputStyle} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Spend limit (USDC)
            </label>
            <input
              style={inputStyle}
              value={spendLimit}
              onChange={(e) => setSpendLimit(e.target.value)}
              placeholder="blank = unlimited"
            />
          </div>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Daily limit (USDC)
            </label>
            <input
              style={inputStyle}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              placeholder="blank = no daily limit"
            />
          </div>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Per-transaction limit (USDC)
            </label>
            <input
              style={inputStyle}
              value={txLimit}
              onChange={(e) => setTxLimit(e.target.value)}
              placeholder="blank = no per-tx limit"
            />
          </div>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Require approval above (USDC)
            </label>
            <input
              style={inputStyle}
              value={approvalAbove}
              onChange={(e) => setApprovalAbove(e.target.value)}
              placeholder="blank = never require approval"
            />
          </div>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Default webhook URL (HTTPS)
            </label>
            <input
              style={inputStyle}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: '0.75rem',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                display: 'block',
                marginBottom: '0.375rem',
              }}
            >
              Agent Stellar address
            </label>
            <input
              style={inputStyle}
              value={walletKey}
              onChange={(e) => setWalletKey(e.target.value)}
            />
          </div>
          {err && <p style={{ color: '#f87171', fontSize: '0.8125rem', margin: 0 }}>{err}</p>}
        </div>
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            marginTop: '1.5rem',
            justifyContent: 'flex-end',
          }}
        >
          <button style={btnStyle('ghost')} onClick={onClose}>
            Cancel
          </button>
          <button style={btnStyle('primary')} onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── New Key Result Modal ─────────────────────────────────────────────────────

function NewKeyResult({
  data,
  onClose,
}: {
  data: { key: string; webhook_secret: string; label: string | null };
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--green-border)',
          borderRadius: 12,
          padding: '2rem',
          width: 520,
          maxWidth: '90vw',
        }}
      >
        <div
          style={{
            color: 'var(--green)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: '0.75rem',
          }}
        >
          Key created — save these now
        </div>
        <p
          style={{
            color: 'var(--muted)',
            fontSize: '0.8125rem',
            marginBottom: '1.25rem',
            lineHeight: 1.6,
          }}
        >
          These secrets will not be shown again. Store them securely before closing.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div>
            <div
              style={{
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--muted)',
                marginBottom: '0.375rem',
              }}
            >
              API KEY
            </div>
            <pre
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '0.75rem',
                fontSize: '0.8125rem',
                wordBreak: 'break-all',
                margin: 0,
                color: 'var(--green)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {data.key}
            </pre>
          </div>
          <div>
            <div
              style={{
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--muted)',
                marginBottom: '0.375rem',
              }}
            >
              WEBHOOK SECRET
            </div>
            <pre
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '0.75rem',
                fontSize: '0.8125rem',
                wordBreak: 'break-all',
                margin: 0,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {data.webhook_secret}
            </pre>
          </div>
        </div>
        <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
          <button style={btnStyle('primary')} onClick={onClose}>
            I&apos;ve saved these
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Tab = 'keys' | 'orders' | 'approvals';

export default function DashboardPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  // `authed` derived from /api/auth/me — the backend token lives in an
  // HttpOnly cookie that the browser never reads.
  const [authed, setAuthed] = useState(false);
  const [userRole, setUserRole] = useState('');
  const [loading, setLoading] = useState(false);
  const [authErr, setAuthErr] = useState('');

  const [tab, setTab] = useState<Tab>('keys');
  const [dashInfo, setDashInfo] = useState<DashboardInfo | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [dataErr, setDataErr] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [editKey, setEditKey] = useState<ApiKey | null>(null);
  const [newKeyResult, setNewKeyResult] = useState<{
    key: string;
    webhook_secret: string;
    label: string | null;
  } | null>(null);

  const fetchAll = useCallback(async () => {
    if (!authed) return;
    setDataErr('');
    try {
      const [infoRes, keysRes, ordersRes, approvalsRes] = await Promise.all([
        fetch(`${API_BASE}/dashboard`),
        fetch(`${API_BASE}/dashboard/api-keys`),
        fetch(`${API_BASE}/dashboard/orders?limit=100`),
        fetch(`${API_BASE}/dashboard/approval-requests?status=pending`),
      ]);
      if (!infoRes.ok) {
        setDataErr('Session expired. Please refresh.');
        return;
      }
      const [info, ks, os, as] = await Promise.all([
        infoRes.json(),
        keysRes.json(),
        ordersRes.json(),
        approvalsRes.json(),
      ]);
      setDashInfo(info);
      setKeys(Array.isArray(ks) ? ks : []);
      setOrders(Array.isArray(os) ? os : []);
      setApprovals(Array.isArray(as) ? as : []);
    } catch {
      setDataErr('Failed to load data.');
    }
  }, [authed]);

  // Restore session from the HttpOnly cookie on mount (S-HO-1).
  useEffect(() => {
    fetch(`${AUTH_BASE}/me`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        setAuthed(true);
        setUserRole(data.user?.role ?? 'user');
        setStep('done');
      })
      .catch(() => {
        /* not logged in */
      });
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ── Auth ──────────────────────────────────────────────────────────────────

  async function sendCode() {
    setLoading(true);
    setAuthErr('');
    const res = await fetch(`${AUTH_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = await res.json();
      setAuthErr(d.message || 'Failed to send code.');
      return;
    }
    setStep('code');
  }

  async function verifyCode() {
    setLoading(true);
    setAuthErr('');
    const res = await fetch(`${AUTH_BASE}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = await res.json();
      setAuthErr(d.message || 'Invalid code.');
      return;
    }
    const data = await res.json();
    setAuthed(true);
    setUserRole(data.user?.role ?? 'user');
    setStep('done');
  }

  // ── Key actions ───────────────────────────────────────────────────────────

  async function toggleKey(key: ApiKey) {
    await fetch(`${API_BASE}/dashboard/api-keys/${key.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: key.enabled ? 0 : 1 }),
    });
    fetchAll();
  }

  async function suspendKey(key: ApiKey) {
    const action = key.suspended ? 'unsuspend' : 'suspend';
    await fetch(`${API_BASE}/dashboard/api-keys/${key.id}/${action}`, { method: 'POST' });
    fetchAll();
  }

  async function deleteKey(key: ApiKey) {
    if (!confirm(`Delete key "${key.label || key.id}"? This cannot be undone.`)) return;
    await fetch(`${API_BASE}/dashboard/api-keys/${key.id}`, { method: 'DELETE' });
    fetchAll();
  }

  // ── Approval actions ──────────────────────────────────────────────────────

  async function decide(approvalId: string, action: 'approve' | 'reject') {
    await fetch(`${API_BASE}/dashboard/approval-requests/${approvalId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    fetchAll();
  }

  // ── Login form ────────────────────────────────────────────────────────────

  if (step !== 'done') {
    return (
      <div
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
            width: 380,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '2rem',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              color: 'var(--green)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: '1rem',
            }}
          >
            Dashboard login
          </div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Sign in to your account
          </h1>
          <p
            style={{
              color: 'var(--muted)',
              fontSize: '0.8125rem',
              lineHeight: 1.6,
              marginBottom: '1.5rem',
            }}
          >
            {step === 'email'
              ? 'Enter your email to receive a login code.'
              : `Check your inbox — we sent a code to ${email}.`}
          </p>
          {step === 'email' ? (
            <>
              <input
                style={{ ...inputStyle, marginBottom: '1rem' }}
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendCode()}
              />
              <button
                style={{ ...btnStyle('primary'), width: '100%' }}
                onClick={sendCode}
                disabled={loading || !email.trim()}
              >
                {loading ? 'Sending…' : 'Send code'}
              </button>
            </>
          ) : (
            <>
              <input
                style={{
                  ...inputStyle,
                  marginBottom: '1rem',
                  letterSpacing: '0.15em',
                  textAlign: 'center',
                  fontSize: '1.25rem',
                }}
                type="text"
                placeholder="123456"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && verifyCode()}
                autoFocus
              />
              <button
                style={{ ...btnStyle('primary'), width: '100%', marginBottom: '0.75rem' }}
                onClick={verifyCode}
                disabled={loading || code.length < 6}
              >
                {loading ? 'Verifying…' : 'Sign in'}
              </button>
              <button
                style={{ ...btnStyle('ghost'), width: '100%', fontSize: '0.8125rem' }}
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setAuthErr('');
                }}
              >
                Use a different email
              </button>
            </>
          )}
          {authErr && (
            <p
              style={{
                color: '#f87171',
                fontSize: '0.8125rem',
                marginTop: '0.75rem',
                margin: '0.75rem 0 0',
              }}
            >
              {authErr}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  const s = dashInfo?.stats;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '2rem 1.5rem' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              color: 'var(--muted)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginBottom: '0.25rem',
            }}
          >
            Dashboard
          </div>
          <h1
            style={{ fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}
          >
            {dashInfo?.name || email}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {userRole === 'owner' && (
            <a
              href="/admin"
              style={{
                ...btnStyle('ghost'),
                textDecoration: 'none',
                fontSize: '0.8125rem',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Super-admin
            </a>
          )}
          <button
            style={btnStyle('ghost')}
            onClick={async () => {
              await fetch(`${AUTH_BASE}/logout`, { method: 'POST' });
              setAuthed(false);
              setStep('email');
              setCode('');
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {dataErr && (
        <div
          style={{
            background: 'rgba(248,113,113,0.1)',
            border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 8,
            padding: '0.875rem 1rem',
            marginBottom: '1.5rem',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          {dataErr}
        </div>
      )}

      {/* Stats row */}
      {s && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
            marginBottom: '2rem',
            background: 'var(--surface)',
          }}
        >
          <Stat
            label="Total GMV"
            value={`$${Number(s.total_gmv).toFixed(2)}`}
            color="var(--green)"
          />
          <Stat label="Delivered" value={s.delivered} />
          <Stat label="Pending" value={s.pending} />
          <Stat label="Failed" value={s.failed} />
          <Stat label="Active agents" value={s.active_keys} />
          <Stat
            label="Pending approvals"
            value={s.pending_approvals}
            color={s.pending_approvals > 0 ? '#facc15' : undefined}
          />
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.25rem',
          borderBottom: '1px solid var(--border)',
          marginBottom: '1.5rem',
        }}
      >
        {(['keys', 'orders', 'approvals'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '0.625rem 1rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
              fontWeight: 600,
              borderBottom: `2px solid ${tab === t ? 'var(--green)' : 'transparent'}`,
              color: tab === t ? 'var(--fg)' : 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              transition: 'color 0.15s',
            }}
          >
            {t === 'keys'
              ? `Agents (${keys.length})`
              : t === 'orders'
                ? `Orders (${orders.length})`
                : `Approvals (${approvals.length})`}
          </button>
        ))}
      </div>

      {/* ── API Keys tab ─────────────────────────────────────────────────── */}
      {tab === 'keys' && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <p style={{ color: 'var(--muted)', fontSize: '0.875rem', margin: 0 }}>
              Each API key is one agent. Agents use their key to request virtual cards.
            </p>
            <button style={btnStyle('primary')} onClick={() => setShowCreate(true)}>
              + New agent key
            </button>
          </div>

          {keys.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '4rem 2rem',
                color: 'var(--muted)',
                fontSize: '0.875rem',
              }}
            >
              No agent keys yet. Create one to get started.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {keys.map((k) => {
                const spent = parseFloat(k.total_spent_usdc || '0');
                const limit = k.spend_limit_usdc ? parseFloat(k.spend_limit_usdc) : null;
                const pct = limit ? Math.min(100, (spent / limit) * 100) : 0;
                const isActive = k.enabled && !k.suspended;
                const statusColor = k.suspended
                  ? '#f87171'
                  : k.enabled
                    ? 'var(--green)'
                    : 'var(--muted)';
                return (
                  <div
                    key={k.id}
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '1.25rem 1.5rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '1rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.625rem',
                            marginBottom: '0.25rem',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: '0.9375rem' }}>
                            {k.label || 'Unlabeled key'}
                          </span>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontFamily: 'var(--font-mono)',
                              color: statusColor,
                              fontWeight: 600,
                            }}
                          >
                            {k.suspended ? 'suspended' : k.enabled ? 'active' : 'disabled'}
                          </span>
                          {k.mode === 'sandbox' && (
                            <span
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: '#fb923c',
                                background: 'rgba(251,146,60,0.1)',
                                border: '1px solid rgba(251,146,60,0.3)',
                                borderRadius: 4,
                                padding: '0.1rem 0.4rem',
                                fontWeight: 600,
                              }}
                            >
                              sandbox
                            </span>
                          )}
                          {k.expires_at && new Date(k.expires_at) <= new Date() && (
                            <span
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: '#f87171',
                                fontWeight: 600,
                              }}
                            >
                              expired
                            </span>
                          )}
                          {k.expires_at && new Date(k.expires_at) > new Date() && (
                            <span
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--muted)',
                              }}
                            >
                              expires {new Date(k.expires_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.7rem',
                            color: 'var(--muted)',
                          }}
                        >
                          {k.id}
                        </div>
                        {k.last_used_at && (
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--muted)',
                              marginTop: '0.25rem',
                            }}
                          >
                            Last used {fmt(k.last_used_at)}
                          </div>
                        )}
                        {k.policy_require_approval_above_usdc && (
                          <div
                            style={{ fontSize: '0.75rem', color: '#facc15', marginTop: '0.25rem' }}
                          >
                            Requires approval above ${k.policy_require_approval_above_usdc}
                          </div>
                        )}
                      </div>
                      <div style={{ minWidth: 160 }}>
                        <div
                          style={{
                            fontSize: '0.7rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--muted)',
                            marginBottom: '0.375rem',
                          }}
                        >
                          SPENT
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.9375rem',
                            fontWeight: 700,
                            color: isActive ? 'var(--fg)' : 'var(--muted)',
                          }}
                        >
                          ${spent.toFixed(2)}
                          {limit ? ` / $${limit.toFixed(2)}` : ' / ∞'}
                        </div>
                        {limit && (
                          <div
                            style={{
                              height: 4,
                              background: 'var(--border)',
                              borderRadius: 2,
                              overflow: 'hidden',
                              marginTop: '0.375rem',
                            }}
                          >
                            <div
                              style={{
                                height: '100%',
                                width: `${pct}%`,
                                background:
                                  pct > 90 ? '#f87171' : pct > 70 ? '#fb923c' : 'var(--green)',
                                borderRadius: 2,
                                transition: 'width 0.3s',
                              }}
                            />
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.5rem',
                          flexWrap: 'wrap',
                          alignItems: 'flex-start',
                        }}
                      >
                        <button
                          style={{
                            ...btnStyle('ghost'),
                            fontSize: '0.8125rem',
                            padding: '0.375rem 0.75rem',
                          }}
                          onClick={() => setEditKey(k)}
                        >
                          Edit
                        </button>
                        <button
                          style={{
                            ...btnStyle('ghost'),
                            fontSize: '0.8125rem',
                            padding: '0.375rem 0.75rem',
                          }}
                          onClick={() => toggleKey(k)}
                        >
                          {k.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          style={{
                            ...btnStyle(k.suspended ? 'ghost' : 'danger'),
                            fontSize: '0.8125rem',
                            padding: '0.375rem 0.75rem',
                          }}
                          onClick={() => suspendKey(k)}
                        >
                          {k.suspended ? 'Unsuspend' : 'Suspend'}
                        </button>
                        <button
                          style={{
                            ...btnStyle('ghost'),
                            fontSize: '0.8125rem',
                            padding: '0.375rem 0.75rem',
                            color: '#f87171',
                            borderColor: 'rgba(248,113,113,0.3)',
                          }}
                          onClick={() => deleteKey(k)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Orders tab ───────────────────────────────────────────────────── */}
      {tab === 'orders' && (
        <div style={{ overflowX: 'auto' }}>
          {orders.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '4rem 2rem',
                color: 'var(--muted)',
                fontSize: '0.875rem',
              }}
            >
              No orders yet.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Status', 'Agent', 'Amount', 'Card', 'Created', 'Error'].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: 'left',
                        padding: '0.625rem 0.75rem',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.7rem',
                        color: 'var(--muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontWeight: 600,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.75rem' }}>
                      <StatusBadge status={o.status} />
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        color: 'var(--muted)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8125rem',
                      }}
                    >
                      {o.api_key_label || '—'}
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                      }}
                    >
                      ${o.amount_usdc}
                    </td>
                    <td
                      style={{ padding: '0.75rem', color: 'var(--muted)', fontSize: '0.8125rem' }}
                    >
                      {o.card_brand || '—'}
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        color: 'var(--muted)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fmt(o.created_at)}
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        color: '#f87171',
                        fontSize: '0.8125rem',
                        maxWidth: 200,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {o.error || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Approvals tab ────────────────────────────────────────────────── */}
      {tab === 'approvals' && (
        <div>
          {approvals.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '4rem 2rem',
                color: 'var(--muted)',
                fontSize: '0.875rem',
              }}
            >
              No pending approvals.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {approvals.map((a) => (
                <div
                  key={a.id}
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '1.25rem 1.5rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '1rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div
                        style={{ fontWeight: 700, fontSize: '0.9375rem', marginBottom: '0.25rem' }}
                      >
                        ${a.amount_usdc} USDC — {a.api_key_label || a.api_key_id}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.7rem',
                          color: 'var(--muted)',
                          marginBottom: '0.375rem',
                        }}
                      >
                        Order: {a.order_id} · Requested {fmt(a.requested_at)} · Expires{' '}
                        {fmt(a.expires_at)}
                      </div>
                      {a.agent_note && (
                        <div
                          style={{
                            fontSize: '0.8125rem',
                            color: 'var(--fg)',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            padding: '0.5rem 0.75rem',
                            marginTop: '0.5rem',
                          }}
                        >
                          {a.agent_note}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button style={btnStyle('primary')} onClick={() => decide(a.id, 'approve')}>
                        Approve
                      </button>
                      <button style={btnStyle('danger')} onClick={() => decide(a.id, 'reject')}>
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <CreateKeyModal
          onClose={() => setShowCreate(false)}
          onCreated={(data) => {
            setShowCreate(false);
            setNewKeyResult(data);
            fetchAll();
          }}
        />
      )}
      {editKey && (
        <EditKeyModal
          keyData={editKey}
          onClose={() => setEditKey(null)}
          onSaved={() => {
            setEditKey(null);
            fetchAll();
          }}
        />
      )}
      {newKeyResult && <NewKeyResult data={newKeyResult} onClose={() => setNewKeyResult(null)} />}
    </div>
  );
}
