'use client';

// Per-user dashboard — manage your agents (API keys), view orders, handle approvals.
// Authenticated via email login code → session Bearer token.

import { useState, useEffect, useCallback } from 'react';

// All backend calls go through /api/admin-proxy so the Bearer token stays in
// an HttpOnly cookie (see web/app/api/admin-proxy/[...path]/route.ts).
const API_BASE = '/api/admin-proxy';
const AUTH_BASE = '/api/auth';

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentState {
  state: 'minted' | 'initializing' | 'awaiting_funding' | 'funded' | 'active';
  label: string;
  detail: string | null;
  since: string | null;
  wallet_public_key: string | null;
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

const AGENT_STATE_COLORS: Record<string, string> = {
  minted: '#6b7280',
  initializing: '#facc15',
  awaiting_funding: '#fb923c',
  funded: '#60a5fa',
  active: '#22c55e',
};
const AGENT_STATE_LABELS: Record<string, string> = {
  minted: 'Minted',
  initializing: 'Setting up',
  awaiting_funding: 'Awaiting deposit',
  funded: 'Funded',
  active: 'Active',
};

interface NewKeyData {
  id: string;
  key: string;
  webhook_secret: string;
  label: string | null;
  claim?: { code: string; expires_at: string; ttl_ms: number };
}

function AgentStatePill({ apiKey }: { apiKey: ApiKey }) {
  const state = apiKey.agent?.state ?? 'minted';
  const color = AGENT_STATE_COLORS[state] ?? AGENT_STATE_COLORS.minted;
  const label = apiKey.agent?.label ?? AGENT_STATE_LABELS[state] ?? 'Minted';
  return (
    <span
      title={apiKey.agent?.detail ?? undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.375rem',
        fontSize: '0.7rem',
        fontFamily: 'var(--font-mono)',
        color,
        padding: '0.2rem 0.55rem',
        borderRadius: 4,
        border: `1px solid ${color}33`,
        background: `${color}14`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          animation:
            state === 'initializing' || state === 'awaiting_funding'
              ? 'pulse 2s ease-in-out infinite'
              : undefined,
        }}
      />
      {label}
    </span>
  );
}

// ── Agent detail view ────────────────────────────────────────────────────────
// Rendered when the user clicks an agent row. Self-contained: title +
// state pill + wallet (address + live balance + copy) + recent orders +
// action menu. The action menu (Edit / Disable / Suspend / Delete)
// lives here instead of on the main row to keep the list compact.

function AgentDetailView({
  apiKey,
  balance,
  orders,
  onBack,
  onEdit,
  onToggle,
  onSuspend,
  onDelete,
}: {
  apiKey: ApiKey;
  balance: { xlm: string; usdc: string } | null;
  orders: Order[];
  onBack: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onSuspend: () => void;
  onDelete: () => void;
}) {
  const k = apiKey;
  const [addressCopied, setAddressCopied] = useState(false);
  const spent = parseFloat(k.total_spent_usdc || '0');
  const limit = k.spend_limit_usdc ? parseFloat(k.spend_limit_usdc) : null;

  function copyAddress() {
    if (!k.wallet_public_key) return;
    navigator.clipboard.writeText(k.wallet_public_key);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 1500);
  }

  return (
    <div>
      <button
        onClick={onBack}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--muted)',
          fontSize: '0.8125rem',
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          padding: 0,
          marginBottom: '1rem',
        }}
      >
        ← Back to agents
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.875rem',
          flexWrap: 'wrap',
          marginBottom: '0.5rem',
        }}
      >
        <h2
          style={{
            fontSize: '1.375rem',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
          }}
        >
          {k.label || 'Unlabeled agent'}
        </h2>
        <AgentStatePill apiKey={k} />
        {k.suspended && (
          <span
            style={{
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono)',
              color: '#f87171',
              fontWeight: 600,
            }}
          >
            suspended
          </span>
        )}
        {!k.enabled && (
          <span
            style={{
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              fontWeight: 600,
            }}
          >
            disabled
          </span>
        )}
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
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          color: 'var(--muted)',
          marginBottom: '1.75rem',
        }}
      >
        {k.id}
      </div>

      {/* Wallet card */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '1.25rem 1.5rem',
          marginBottom: '1.5rem',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '0.625rem',
          }}
        >
          Stellar wallet
        </div>
        {k.wallet_public_key ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.625rem',
                marginBottom: '0.875rem',
              }}
            >
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                  wordBreak: 'break-all',
                  flex: 1,
                }}
              >
                {k.wallet_public_key}
              </code>
              <button
                onClick={copyAddress}
                style={{
                  background: addressCopied ? 'var(--green)' : 'transparent',
                  color: addressCopied ? '#000' : 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '0.3125rem 0.75rem',
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {addressCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
              <div>
                <div
                  style={{
                    fontSize: '0.65rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  USDC
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '1.25rem',
                    fontWeight: 700,
                    color: 'var(--green)',
                  }}
                >
                  {balance ? balance.usdc : '—'}
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: '0.65rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  XLM
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '1.25rem',
                    fontWeight: 700,
                  }}
                >
                  {balance ? balance.xlm : '—'}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200, color: 'var(--muted)', fontSize: '0.75rem' }}>
                Send XLM or USDC to the address above to fund this agent. Polling Horizon every 30s.
              </div>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: '0.8125rem' }}>
            This agent hasn&apos;t reported a wallet yet. Once it runs{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>cards402 onboard</code>, the address
            and balance will appear here.
          </div>
        )}
      </div>

      {/* Spend card */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '1.25rem 1.5rem',
          marginBottom: '1.5rem',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '0.5rem',
          }}
        >
          Spend
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '1.5rem',
            fontWeight: 700,
            marginBottom: limit ? '0.5rem' : 0,
          }}
        >
          ${spent.toFixed(2)}
          {limit ? (
            <span style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
              {' '}
              / ${limit.toFixed(2)} cap
            </span>
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: '0.875rem' }}> · no cap</span>
          )}
        </div>
        {k.policy_require_approval_above_usdc && (
          <div style={{ fontSize: '0.75rem', color: '#facc15', marginTop: '0.5rem' }}>
            Requires owner approval above ${k.policy_require_approval_above_usdc}
          </div>
        )}
        {k.last_used_at && (
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.375rem' }}>
            Last used {fmt(k.last_used_at)}
          </div>
        )}
      </div>

      {/* Recent orders */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '1.25rem 1.5rem',
          marginBottom: '1.5rem',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '0.75rem',
          }}
        >
          Recent orders ({orders.length})
        </div>
        {orders.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: '0.8125rem' }}>
            No orders yet. They&apos;ll appear here once the agent makes its first purchase.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {orders.slice(0, 10).map((o) => (
              <div
                key={o.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.875rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                }}
              >
                <span style={{ color: 'var(--muted)', minWidth: 90 }}>{o.id.slice(0, 8)}</span>
                <span style={{ flex: 1 }}>${o.amount_usdc}</span>
                <StatusBadge status={o.status} />
                <span style={{ color: 'var(--muted)' }}>{fmt(o.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action menu */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '1.25rem 1.5rem',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: '0.75rem',
          }}
        >
          Actions
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            style={{ ...btnStyle('ghost'), fontSize: '0.8125rem', padding: '0.45rem 0.875rem' }}
            onClick={onEdit}
          >
            Edit policy
          </button>
          <button
            style={{ ...btnStyle('ghost'), fontSize: '0.8125rem', padding: '0.45rem 0.875rem' }}
            onClick={onToggle}
          >
            {k.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            style={{
              ...btnStyle(k.suspended ? 'ghost' : 'danger'),
              fontSize: '0.8125rem',
              padding: '0.45rem 0.875rem',
            }}
            onClick={onSuspend}
          >
            {k.suspended ? 'Unsuspend' : 'Suspend'}
          </button>
          <button
            style={{
              ...btnStyle('ghost'),
              fontSize: '0.8125rem',
              padding: '0.45rem 0.875rem',
              color: '#f87171',
              borderColor: 'rgba(248,113,113,0.3)',
            }}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
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
  api_key_id: string;
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

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

async function fetchHorizonBalance(
  publicKey: string,
): Promise<{ xlm: string; usdc: string } | null> {
  try {
    const res = await fetch(`https://horizon.stellar.org/accounts/${publicKey}`);
    if (!res.ok) return { xlm: '0', usdc: '0' }; // unactivated
    const data = (await res.json()) as {
      balances: Array<{
        asset_type: string;
        asset_code?: string;
        asset_issuer?: string;
        balance: string;
      }>;
    };
    const balances = data.balances ?? [];
    const xlm = balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
    const usdc =
      balances.find(
        (b) =>
          b.asset_type === 'credit_alphanum4' &&
          b.asset_code === 'USDC' &&
          b.asset_issuer === USDC_ISSUER,
      )?.balance ?? '0';
    return { xlm: parseFloat(xlm).toFixed(4), usdc: parseFloat(usdc).toFixed(2) };
  } catch {
    return null;
  }
}

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
  onCreated: (key: NewKeyData) => void;
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

// ── Live agent onboarding modal ──────────────────────────────────────────────
// Opens when a new key is created and walks the operator through a live
// stepper driven by the per-tenant SSE feed the parent is already running:
//
//   1. Waiting for handshake   — spinner + paste block with the claim code
//   2. Claim redeemed          — agent CLI completed `cards402 onboard`
//   3. Wallet ready            — wallet address reported, balance polling
//   4. Awaiting deposit        — highlighted address + live balance
//   5. Funded                  — ready for the first purchase
//   6. Active                  — first delivered order recorded
//
// `liveKey` is the corresponding row from the parent's `keys` state.
// Because the parent refetches on every SSE event, this prop reactively
// updates every time the backend fires anything that touches the row.

function NewKeyResult({
  data,
  liveKey,
  onClose,
}: {
  data: NewKeyData;
  liveKey: ApiKey | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [horizonBalance, setHorizonBalance] = useState<{ xlm: string; usdc: string } | null>(null);

  // Derive the current step from liveKey + horizon balance. Both are
  // reactive inputs so the stepper advances automatically.
  const agentState = liveKey?.agent?.state ?? 'minted';
  const walletAddress = liveKey?.agent?.wallet_public_key ?? liveKey?.wallet_public_key ?? null;
  const xlmNum = parseFloat(horizonBalance?.xlm ?? '0');
  const usdcNum = parseFloat(horizonBalance?.usdc ?? '0');
  const hasFunds = xlmNum >= 1 || usdcNum > 0;

  type Step = 'waiting' | 'claimed' | 'wallet' | 'awaiting_deposit' | 'funded' | 'active';

  let step: Step = 'waiting';
  if (agentState === 'active') step = 'active';
  else if (hasFunds && walletAddress) step = 'funded';
  else if (agentState === 'awaiting_funding' && walletAddress) step = 'awaiting_deposit';
  else if (walletAddress) step = 'wallet';
  else if (agentState === 'initializing') step = 'claimed';

  // Poll Horizon for live balance as soon as we know the wallet address.
  // 5s interval — fast enough that funding shows up within the same
  // breath the operator hits Send on their exchange.
  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`https://horizon.stellar.org/accounts/${walletAddress}`);
        if (cancelled) return;
        if (!res.ok) {
          // Unactivated accounts 404 on Horizon — treat as 0/0 and keep polling.
          setHorizonBalance({ xlm: '0', usdc: '0' });
          return;
        }
        const payload = (await res.json()) as {
          balances: Array<{
            asset_type: string;
            asset_code?: string;
            asset_issuer?: string;
            balance: string;
          }>;
        };
        const balances = payload.balances ?? [];
        const xlm = balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
        const usdc =
          balances.find(
            (b) =>
              b.asset_code === 'USDC' &&
              b.asset_issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          )?.balance ?? '0';
        setHorizonBalance({
          xlm: parseFloat(xlm).toFixed(4),
          usdc: parseFloat(usdc).toFixed(2),
        });
      } catch {
        /* transient — next tick will retry */
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [walletAddress]);

  // Guard: the backend must return a claim code. If it's missing, the
  // dashboard is running against a pre-claim backend — surface an
  // error rather than silently falling back to pasting the raw key.
  if (!data.claim) {
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
            border: '1px solid #f87171',
            borderRadius: 12,
            padding: '2rem',
            width: 520,
            maxWidth: '92vw',
          }}
        >
          <h3 style={{ color: '#f87171', marginTop: 0 }}>Backend too old</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
            The dashboard expected a one-time claim code in the create-key response but the backend
            didn&apos;t return one. This usually means the server is running a version older than
            the frontend. Refresh and try again; if it persists, check the deploy.
          </p>
          <button style={btnStyle('primary')} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const snippet = [
    'Read https://cards402.com/skill.md',
    'and set up this agent by running:',
    '',
    `  npx cards402 onboard --claim ${data.claim.code}`,
  ].join('\n');

  async function copy() {
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function Spinner() {
    return (
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.15)',
          borderTopColor: 'var(--green)',
          animation: 'spin 0.8s linear infinite',
          marginRight: '0.5rem',
          verticalAlign: 'middle',
        }}
      />
    );
  }

  function StepRow({
    state,
    title,
    detail,
  }: {
    state: 'pending' | 'active' | 'done';
    title: string;
    detail?: React.ReactNode;
  }) {
    const color =
      state === 'done' ? 'var(--green)' : state === 'active' ? '#facc15' : 'var(--muted)';
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.625rem',
          padding: '0.5rem 0',
          opacity: state === 'pending' ? 0.5 : 1,
        }}
      >
        <span
          style={{
            marginTop: 4,
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
            animation: state === 'active' ? 'pulse 2s ease-in-out infinite' : undefined,
          }}
        />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: '0.8125rem',
              fontFamily: 'var(--font-mono)',
              color,
              fontWeight: state === 'done' ? 400 : 600,
            }}
          >
            {state === 'done' ? '✓ ' : ''}
            {title}
          </div>
          {detail && (
            <div style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
              {detail}
            </div>
          )}
        </div>
      </div>
    );
  }

  const stepOrder: Step[] = [
    'waiting',
    'claimed',
    'wallet',
    'awaiting_deposit',
    'funded',
    'active',
  ];
  const stepIndex = stepOrder.indexOf(step);
  function stepState(s: Step): 'pending' | 'active' | 'done' {
    const i = stepOrder.indexOf(s);
    if (i < stepIndex) return 'done';
    if (i === stepIndex) return 'active';
    return 'pending';
  }

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
        padding: '2rem',
      }}
    >
      <div
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--green-border)',
          borderRadius: 12,
          padding: '2rem',
          width: 640,
          maxWidth: '92vw',
          maxHeight: '92vh',
          overflowY: 'auto',
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
            marginBottom: '0.5rem',
          }}
        >
          Send this to your new agent
        </div>
        <p
          style={{
            color: 'var(--muted)',
            fontSize: '0.8125rem',
            marginBottom: '1.25rem',
            lineHeight: 1.55,
          }}
        >
          The claim code is one-shot and expires in 10 minutes. The raw api key never leaves your
          dashboard — the agent&apos;s CLI trades the code for it over HTTPS.
        </p>
        <div style={{ position: 'relative' }}>
          <pre
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '1rem 1.125rem',
              fontSize: '0.8125rem',
              lineHeight: 1.55,
              margin: 0,
              fontFamily: 'var(--font-mono)',
              whiteSpace: 'pre',
              overflowX: 'auto',
              color: 'var(--fg)',
            }}
          >
            {snippet}
          </pre>
          <button
            onClick={copy}
            style={{
              position: 'absolute',
              top: '0.625rem',
              right: '0.625rem',
              background: copied ? 'var(--green)' : 'var(--bg)',
              color: copied ? '#000' : 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '0.25rem 0.625rem',
              fontSize: '0.6875rem',
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {/* Live progress stepper */}
        <div
          style={{
            marginTop: '1.75rem',
            padding: '1rem 1.125rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          <div
            style={{
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: '0.5rem',
            }}
          >
            {step === 'active'
              ? 'Setup complete'
              : step === 'funded'
                ? 'Funded — ready to buy cards'
                : 'Live setup progress'}
          </div>

          <StepRow
            state={stepState('waiting')}
            title={step === 'waiting' ? 'Waiting for agent handshake' : 'Waiting for agent'}
            detail={
              step === 'waiting' ? (
                <span>
                  <Spinner />
                  Run the command above in your agent&apos;s terminal. The dashboard will update
                  automatically as it progresses — nothing to refresh.
                </span>
              ) : null
            }
          />
          <StepRow
            state={stepState('claimed')}
            title="Claim redeemed"
            detail={
              step === 'claimed' ? (
                <span>
                  <Spinner />
                  Agent traded the claim code for an api key. Creating OWS wallet…
                </span>
              ) : stepIndex > 1 ? (
                'Agent exchanged the claim for an api key.'
              ) : null
            }
          />
          <StepRow
            state={stepState('wallet')}
            title="Wallet created"
            detail={
              walletAddress ? (
                <code
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.7rem',
                    wordBreak: 'break-all',
                  }}
                >
                  {walletAddress}
                </code>
              ) : null
            }
          />
          <StepRow
            state={stepState('awaiting_deposit')}
            title="Awaiting deposit"
            detail={
              step === 'awaiting_deposit' ? (
                <>
                  <div>
                    <Spinner />
                    Polling Horizon every 5s. Send XLM or USDC to the address above to continue.
                  </div>
                  {horizonBalance && (
                    <div style={{ marginTop: '0.375rem', fontFamily: 'var(--font-mono)' }}>
                      balance: {horizonBalance.xlm} XLM · {horizonBalance.usdc} USDC
                    </div>
                  )}
                </>
              ) : null
            }
          />
          <StepRow
            state={stepState('funded')}
            title="Funded"
            detail={
              horizonBalance && stepIndex >= stepOrder.indexOf('funded') ? (
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {horizonBalance.xlm} XLM · {horizonBalance.usdc} USDC
                </span>
              ) : null
            }
          />
          <StepRow
            state={stepState('active')}
            title="Active — first card delivered"
            detail={
              liveKey?.agent?.detail && stepIndex === stepOrder.indexOf('active')
                ? liveKey.agent.detail
                : null
            }
          />
        </div>

        <details
          style={{
            marginTop: '1.25rem',
            color: 'var(--muted)',
            fontSize: '0.75rem',
          }}
        >
          <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
            Advanced — reveal raw api key (only if you need to bypass the CLI onboard flow)
          </summary>
          <p style={{ marginTop: '0.5rem' }}>
            Most operators should never need this. The raw api key is only useful if you&apos;re
            wiring the SDK into an existing app that manages its own wallet — and in that case you
            should set <code>CARDS402_API_KEY</code> manually rather than pasting it into an
            agent&apos;s chat.
          </p>
          <button onClick={() => setRevealKey((r) => !r)} style={btnStyle('ghost')}>
            {revealKey ? 'Hide raw key' : 'Reveal raw key'}
          </button>
          {revealKey && (
            <pre
              style={{
                background: '#000',
                border: '1px solid #333',
                borderRadius: 6,
                padding: '0.625rem 0.75rem',
                fontSize: '0.7rem',
                wordBreak: 'break-all',
                margin: '0.5rem 0 0',
                fontFamily: 'var(--font-mono)',
                color: '#fca5a5',
              }}
            >
              {data.key}
            </pre>
          )}
        </details>

        <div
          style={{
            marginTop: '1.5rem',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.75rem',
          }}
        >
          <button style={btnStyle('primary')} onClick={onClose}>
            {step === 'active' || step === 'funded' ? 'Done' : 'Close'}
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
  const [newKeyResult, setNewKeyResult] = useState<NewKeyData | null>(null);

  // Per-agent live Stellar balances, fetched directly from Horizon
  // for any key whose agent has reported a wallet_public_key. Polled
  // every 30s + on every keys refetch — fast enough that funding
  // shows up in the row promptly without hammering Horizon.
  const [walletBalances, setWalletBalances] = useState<
    Record<string, { xlm: string; usdc: string }>
  >({});

  // Per-agent detail view. Drives via a ?agent=<id> query string so
  // a permalink works, but updates URL via history.pushState to
  // avoid the Suspense gymnastics that useSearchParams forces.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function syncFromUrl() {
      const params = new URLSearchParams(window.location.search);
      setSelectedAgentId(params.get('agent'));
    }
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);
  function selectAgent(id: string | null) {
    setSelectedAgentId(id);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('agent', id);
    else url.searchParams.delete('agent');
    window.history.pushState({}, '', url.toString());
  }

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

  // Horizon balance polling for every key that has reported a wallet
  // address. Refreshes immediately when a new key appears and every
  // 30s after that. Runs only while authed to avoid hammering Horizon
  // for nothing when the user is logged out or on the login wall.
  useEffect(() => {
    if (!authed) return;
    const walletKeys = keys.filter((k) => k.wallet_public_key);
    if (walletKeys.length === 0) return;

    let cancelled = false;
    async function pollAll() {
      for (const k of walletKeys) {
        const bal = await fetchHorizonBalance(k.wallet_public_key!);
        if (cancelled || !bal) continue;
        setWalletBalances((prev) => ({ ...prev, [k.id]: bal }));
      }
    }
    pollAll();
    const id = setInterval(pollAll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Re-run when the set of walletAddress-bearing keys changes (not
    // on every render). Serialise to a stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, keys.map((k) => `${k.id}:${k.wallet_public_key ?? ''}`).join('|')]);

  // Live SSE feed from /dashboard/stream. Pushes an event any time one
  // of the user's agents reports a state transition, one of their
  // orders changes phase, or an approval decision is recorded. Any
  // event triggers a full refetch — it's local HTTP, ~10ms. If the
  // stream drops we reopen with a short backoff, and a 60s safety net
  // ensures the UI stays fresh even if SSE is blocked entirely.
  useEffect(() => {
    if (!authed) return;
    let closed = false;
    let abortController: AbortController | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    const safetyNet = setInterval(() => fetchAll(), 60_000);

    async function openStream() {
      if (closed) return;
      abortController = new AbortController();
      try {
        const res = await fetch(`${API_BASE}/dashboard/stream`, {
          headers: { Accept: 'text/event-stream' },
          signal: abortController.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream http ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const event = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            fetchAll();
            break;
          }
        }
      } catch {
        /* swallow — reopen with backoff */
      } finally {
        if (!closed) reopenTimer = setTimeout(openStream, 2000);
      }
    }
    openStream();

    return () => {
      closed = true;
      abortController?.abort();
      if (reopenTimer) clearTimeout(reopenTimer);
      clearInterval(safetyNet);
    };
  }, [authed, fetchAll]);

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
      {tab === 'keys' && selectedAgentId ? (
        (() => {
          const k = keys.find((x) => x.id === selectedAgentId);
          if (!k) {
            return (
              <div
                style={{
                  textAlign: 'center',
                  padding: '4rem 2rem',
                  color: 'var(--muted)',
                  fontSize: '0.875rem',
                }}
              >
                Agent not found.{' '}
                <button
                  style={{
                    ...btnStyle('ghost'),
                    fontSize: '0.8125rem',
                    marginLeft: '0.5rem',
                  }}
                  onClick={() => selectAgent(null)}
                >
                  Back to agents
                </button>
              </div>
            );
          }
          return (
            <AgentDetailView
              apiKey={k}
              balance={walletBalances[k.id] ?? null}
              orders={orders.filter((o) => o.api_key_id === k.id)}
              onBack={() => selectAgent(null)}
              onEdit={() => setEditKey(k)}
              onToggle={() => toggleKey(k)}
              onSuspend={() => suspendKey(k)}
              onDelete={() => {
                deleteKey(k);
                selectAgent(null);
              }}
            />
          );
        })()
      ) : tab === 'keys' ? (
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
              Each API key is one agent. Click an agent to see its wallet, balance, and actions.
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
                const balance = walletBalances[k.id];
                return (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => selectAgent(k.id)}
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '1rem 1.25rem',
                      textAlign: 'left',
                      cursor: 'pointer',
                      color: 'var(--fg)',
                      width: '100%',
                      fontFamily: 'inherit',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--green-border)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border)';
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '1.25rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.625rem',
                            marginBottom: '0.375rem',
                            flexWrap: 'wrap',
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: '0.9375rem' }}>
                            {k.label || 'Unlabeled agent'}
                          </span>
                          <AgentStatePill apiKey={k} />
                          {k.suspended && (
                            <span
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: '#f87171',
                                fontWeight: 600,
                              }}
                            >
                              suspended
                            </span>
                          )}
                          {!k.enabled && (
                            <span
                              style={{
                                fontSize: '0.65rem',
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--muted)',
                                fontWeight: 600,
                              }}
                            >
                              disabled
                            </span>
                          )}
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
                        </div>
                        {k.wallet_public_key ? (
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: 'var(--muted)',
                              wordBreak: 'break-all',
                            }}
                          >
                            {k.wallet_public_key.slice(0, 8)}…{k.wallet_public_key.slice(-6)}
                          </div>
                        ) : (
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.7rem',
                              color: 'var(--muted)',
                            }}
                          >
                            no wallet yet
                          </div>
                        )}
                      </div>
                      <div style={{ minWidth: 130, textAlign: 'right' }}>
                        <div
                          style={{
                            fontSize: '0.65rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            marginBottom: '0.25rem',
                          }}
                        >
                          Wallet balance
                        </div>
                        {balance ? (
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: '0.875rem',
                              fontWeight: 700,
                            }}
                          >
                            <span style={{ color: 'var(--green)' }}>{balance.usdc}</span>
                            <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}> USDC</span>
                            <div
                              style={{
                                fontSize: '0.7rem',
                                color: 'var(--muted)',
                                marginTop: '0.125rem',
                              }}
                            >
                              {balance.xlm} XLM
                            </div>
                          </div>
                        ) : k.wallet_public_key ? (
                          <div
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--muted)',
                              fontFamily: 'var(--font-mono)',
                              opacity: 0.6,
                            }}
                          >
                            loading…
                          </div>
                        ) : (
                          <div
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--muted)',
                              opacity: 0.4,
                            }}
                          >
                            —
                          </div>
                        )}
                      </div>
                      <div style={{ minWidth: 130, textAlign: 'right' }}>
                        <div
                          style={{
                            fontSize: '0.65rem',
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            marginBottom: '0.25rem',
                          }}
                        >
                          Spent
                        </div>
                        <div
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.875rem',
                            fontWeight: 700,
                            color: isActive ? 'var(--fg)' : 'var(--muted)',
                          }}
                        >
                          ${spent.toFixed(2)}
                          {limit ? (
                            <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>
                              {' '}
                              / ${limit.toFixed(2)}
                            </span>
                          ) : null}
                        </div>
                        {limit && (
                          <div
                            style={{
                              height: 3,
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
                          color: 'var(--muted)',
                          fontSize: '1.25rem',
                          marginLeft: '0.25rem',
                          flexShrink: 0,
                        }}
                        aria-hidden
                      >
                        →
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

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
      {newKeyResult && (
        <NewKeyResult
          data={newKeyResult}
          liveKey={keys.find((k) => k.id === newKeyResult.id) ?? null}
          onClose={() => setNewKeyResult(null)}
        />
      )}
    </div>
  );
}
