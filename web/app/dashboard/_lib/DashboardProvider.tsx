// Dashboard-wide data store + SSE subscription. Replaces the old
// 2.6k-line page.tsx that held everything as local useState. Each
// page component consumes the pieces it needs via useDashboard().
//
// Data flow:
//   1. Initial fetchAll() on mount after auth
//   2. SSE /dashboard/stream → triggers fetchAll() on every event
//   3. Horizon balances polled on a 30s interval for funded wallets
//   4. Optimistic local updates (e.g. after createAgent) also refetch
//
// Full refetch on every event is simple and resilient; per-event
// patching is a future optimisation if the agent list gets large.

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  API_BASE,
  USDC_ISSUER,
  type ApiKey,
  type ApprovalRequest,
  type DashboardInfo,
  type Order,
  type User,
  type WalletBalance,
} from './types';
import { fetchAgents, fetchApprovals, fetchDashboard, fetchMe, fetchOrders } from './api';

interface DashboardState {
  loading: boolean;
  authError: string | null;
  user: User | null;
  info: DashboardInfo | null;
  agents: ApiKey[];
  orders: Order[];
  approvals: ApprovalRequest[];
  walletBalances: Record<string, WalletBalance>;
  refresh: () => Promise<void>;
}

const DashboardCtx = createContext<DashboardState | null>(null);

export function useDashboard(): DashboardState {
  const ctx = useContext(DashboardCtx);
  if (!ctx) throw new Error('useDashboard must be used inside <DashboardProvider>');
  return ctx;
}

interface HorizonBalanceResponse {
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
}

async function fetchHorizonBalance(publicKey: string, network?: string): Promise<WalletBalance> {
  try {
    const horizonUrl =
      network === 'testnet' ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org';
    // 5s timeout so a hung Horizon lookup doesn't stall the entire
    // wallet-polling cycle (Promise.all across all agents).
    const res = await fetch(`${horizonUrl}/accounts/${publicKey}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { xlm: '0', usdc: '0' };
    const data: HorizonBalanceResponse = await res.json();
    let xlm = '0';
    let usdc = '0';
    for (const b of data.balances || []) {
      if (b.asset_type === 'native') xlm = b.balance;
      if (
        b.asset_type === 'credit_alphanum4' &&
        b.asset_code === 'USDC' &&
        b.asset_issuer === USDC_ISSUER
      ) {
        usdc = b.balance;
      }
    }
    return { xlm, usdc };
  } catch {
    return { xlm: '0', usdc: '0' };
  }
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [info, setInfo] = useState<DashboardInfo | null>(null);
  const [agents, setAgents] = useState<ApiKey[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [walletBalances, setWalletBalances] = useState<Record<string, WalletBalance>>({});

  // fetchAll grabs everything in parallel. Individual failures are kept
  // isolated — a broken /approval-requests endpoint shouldn't hide
  // agents or orders. Every state setter is defensive against the
  // backend returning an unexpected shape: if the array key is missing
  // we fall back to an empty array so downstream `.filter()` / `.map()`
  // calls can't crash the whole dashboard.
  const refresh = useCallback(async () => {
    const [infoRes, agentsRes, ordersRes, approvalsRes] = await Promise.allSettled([
      fetchDashboard(),
      fetchAgents(),
      fetchOrders(200),
      fetchApprovals(),
    ]);
    if (infoRes.status === 'fulfilled') setInfo(infoRes.value ?? null);
    if (agentsRes.status === 'fulfilled') {
      setAgents(Array.isArray(agentsRes.value?.api_keys) ? agentsRes.value.api_keys : []);
    }
    if (ordersRes.status === 'fulfilled') {
      setOrders(Array.isArray(ordersRes.value?.orders) ? ordersRes.value.orders : []);
    }
    if (approvalsRes.status === 'fulfilled') {
      setApprovals(
        Array.isArray(approvalsRes.value?.approval_requests)
          ? approvalsRes.value.approval_requests
          : [],
      );
    }
  }, []);

  // Auth check on mount. The /api/auth/me proxy returns 401 if the
  // HMAC cookie is missing or tampered, and the page-level AuthGate
  // redirects to the login screen when authError is set.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { user: u } = await fetchMe();
        if (!alive) return;
        setUser(u);
        await refresh();
      } catch (err) {
        if (alive) setAuthError((err as Error).message || 'not authenticated');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // SSE: the backend emits a single event per state change. We don't
  // care about the event body — we just full-refetch. Auto-reconnect
  // with 2s backoff, plus a 60s safety net in case the stream silently
  // wedges behind a proxy that can't do text/event-stream.
  useEffect(() => {
    if (!user) return;
    let closed = false;
    let abort: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const safety = setInterval(() => {
      void refresh();
    }, 60_000);

    async function openStream() {
      if (closed) return;
      abort = new AbortController();
      try {
        const res = await fetch(`${API_BASE}/dashboard/stream`, {
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream http ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          // Normalize CRLF and bare CR to LF before accumulating —
          // same fix as sdk/src/client.ts SSE parser. A proxy that
          // rewrites line endings to \r\n would otherwise prevent
          // '\n\n' from ever matching.
          buf += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const event = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (event.includes('data:')) void refresh();
          }
          // Cap the buffer to prevent unbounded growth on malformed streams.
          if (buf.length > 1024 * 1024) buf = '';
        }
      } catch {
        /* reconnect */
      } finally {
        if (!closed) timer = setTimeout(openStream, 2000);
      }
    }
    void openStream();
    return () => {
      closed = true;
      abort?.abort();
      if (timer) clearTimeout(timer);
      clearInterval(safety);
    };
  }, [user, refresh]);

  // Horizon balances for every agent that has a wallet address. Polls
  // every 30s. Individual account 404s (un-activated wallets) return
  // {0, 0} so the UI always has a value to render.
  const agentsWithWallets = useMemo(() => agents.filter((a) => !!a.wallet_public_key), [agents]);
  const walletKeyList = useMemo(
    () =>
      agentsWithWallets
        .map((a) => `${a.id}:${a.wallet_public_key}`)
        .sort()
        .join(','),
    [agentsWithWallets],
  );
  const walletKeyListRef = useRef(walletKeyList);
  walletKeyListRef.current = walletKeyList;

  useEffect(() => {
    if (!user || agentsWithWallets.length === 0) return;
    let cancelled = false;

    async function pollAll() {
      const entries = await Promise.all(
        agentsWithWallets.map(async (a) => {
          const bal = await fetchHorizonBalance(a.wallet_public_key!, info?.network);
          return [a.id, bal] as const;
        }),
      );
      if (cancelled) return;
      setWalletBalances((prev) => {
        const next = { ...prev };
        for (const [id, bal] of entries) next[id] = bal;
        return next;
      });
    }

    void pollAll();
    const interval = setInterval(pollAll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, agentsWithWallets, info?.network]);

  const value = useMemo<DashboardState>(
    () => ({
      loading,
      authError,
      user,
      info,
      agents,
      orders,
      approvals,
      walletBalances,
      refresh,
    }),
    [loading, authError, user, info, agents, orders, approvals, walletBalances, refresh],
  );

  return <DashboardCtx.Provider value={value}>{children}</DashboardCtx.Provider>;
}
