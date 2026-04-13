export {
  Cards402Error,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  PriceUnavailableError,
  InvalidAmountError,
  AuthError,
  OrderFailedError,
  WaitTimeoutError,
  ResumableError,
} from './errors';
import {
  parseApiError,
  Cards402Error as Cards402ErrorCtor,
  OrderFailedError,
  WaitTimeoutError,
  AuthError as AuthErrorCtor,
} from './errors';

export interface Budget {
  spent_usdc: string;
  limit_usdc: string | null;
  remaining_usdc: string | null;
}

export interface UsageSummary {
  api_key_id: string;
  label: string | null;
  budget: Budget;
  orders: {
    total: number;
    delivered: number;
    failed: number;
    refunded: number;
    in_progress: number;
  };
}

export interface OrderOptions {
  amount_usdc: string;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentInstructions {
  // Tag identifying the payment model — currently always "soroban_contract".
  type: 'soroban_contract';
  // Cards402 receiver contract ID (C...) on Soroban.
  contract_id: string;
  // Order ID — pass this verbatim as the order_id argument to pay_usdc/pay_xlm.
  order_id: string;
  // USDC quote: amount as a 7-decimal string and the SAC asset in "CODE:ISSUER" form.
  usdc: { amount: string; asset: string };
  // XLM quote — present when the order supports XLM payment (always in current backend).
  xlm?: { amount: string };
}

export interface OrderResponse {
  order_id: string;
  status: string;
  payment: PaymentInstructions;
  poll_url: string;
  budget: Budget;
}

export interface CardDetails {
  number: string;
  cvv: string;
  expiry: string;
  brand: string | null;
}

export type OrderPhase =
  | 'awaiting_approval'
  | 'awaiting_payment'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'refunded'
  | 'rejected'
  | 'expired';

// Returned by GET /orders (list) — a subset of OrderStatus without card details.
// Note: uses `id` not `order_id`, and omits `phase` (use status to derive it).
export interface OrderListItem {
  id: string;
  status: string;
  amount_usdc: string;
  payment_asset: string;
  created_at: string;
  updated_at: string;
}

export interface OrderStatus {
  order_id: string;
  status: string;
  phase: OrderPhase;
  amount_usdc: string;
  payment_asset: string;
  card?: CardDetails;
  error?: string;
  note?: string;
  refund?: { stellar_txid: string };
  created_at: string;
  updated_at: string;
}

export interface RetryOptions {
  /** Max number of retry attempts on transient failures. 0 disables retries. */
  attempts?: number;
  /** Initial backoff in ms. Doubles on each retry. */
  baseDelayMs?: number;
  /** Max backoff cap in ms. */
  maxDelayMs?: number;
}

export class Cards402Client {
  private baseUrl: string;
  private apiKey: string;
  private retry: Required<RetryOptions>;

  constructor({
    baseUrl,
    apiKey,
    retry = {},
  }: {
    baseUrl?: string;
    apiKey?: string;
    retry?: RetryOptions;
  } = {}) {
    // Resolve api key + base URL in priority order:
    //   1. Explicit constructor args
    //   2. CARDS402_API_KEY / CARDS402_BASE_URL env vars
    //   3. ~/.cards402/config.json (written by `cards402 onboard`)
    // This lets agents that went through the claim-code onboarding
    // flow just do `new Cards402Client()` without passing anything.
    //
    // Use a synchronous require of ./config so the auto-load path
    // doesn't force callers into an async constructor.
    let resolvedKey = apiKey;
    let resolvedBase = baseUrl;
    if (!resolvedKey || !resolvedBase) {
      try {
        // Synchronous require avoids forcing the constructor to be async.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const config = require('./config');
        const resolved = (
          config as {
            resolveCredentials: (opts: { apiKey?: string; baseUrl?: string }) => {
              apiKey: string | undefined;
              baseUrl: string | undefined;
            };
          }
        ).resolveCredentials({ apiKey: resolvedKey, baseUrl: resolvedBase });
        if (!resolvedKey) resolvedKey = resolved.apiKey;
        if (!resolvedBase) resolvedBase = resolved.baseUrl;
      } catch {
        /* config helper unavailable (e.g. in a browser bundle) — fall through */
      }
    }
    if (!resolvedKey || !resolvedKey.trim()) throw new AuthErrorCtor();
    this.baseUrl = (resolvedBase || 'https://api.cards402.com/v1').replace(/\/$/, '');
    this.apiKey = resolvedKey;
    // Audit A-23: default to retry on transient errors so every agent doesn't
    // reimplement its own backoff loop. 2 retries with 500ms base + 5s cap
    // covers brief network blips without punishing a persistent outage.
    this.retry = {
      attempts: retry.attempts ?? 2,
      baseDelayMs: retry.baseDelayMs ?? 500,
      maxDelayMs: retry.maxDelayMs ?? 5000,
    };
  }

  private async handleError(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw parseApiError(res.status, body);
  }

  // Retry only on transient/network errors. Non-idempotent 2xx-class errors
  // (validation, auth, policy) are NOT retried because they're not transient.
  // createOrder is special-cased: it passes an Idempotency-Key so retries are
  // safe for 5xx and network errors only.
  private shouldRetry(status: number): boolean {
    return status === 429 || status === 503 || status === 504 || status === 502 || status === 0;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const { attempts, baseDelayMs, maxDelayMs } = this.retry;
    let lastErr: unknown;
    for (let i = 0; i <= attempts; i++) {
      try {
        const res = await fetch(url, init);
        if (res.ok || !this.shouldRetry(res.status) || i === attempts) return res;
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
        if (i === attempts) throw err;
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, i), maxDelayMs);
      const jitter = Math.floor(Math.random() * (delay / 4));
      await new Promise((r) => setTimeout(r, delay + jitter));
    }
    // Unreachable because we always either return or throw above.
    throw lastErr ?? new Error('fetchWithRetry: exhausted without result');
  }

  async createOrder(opts: OrderOptions & { idempotencyKey?: string }): Promise<OrderResponse> {
    const { idempotencyKey: providedKey, ...body } = opts;
    const idempotencyKey = providedKey ?? crypto.randomUUID();
    // Safe to retry: the Idempotency-Key collapses duplicate creates on the
    // backend, so replaying on a 5xx/timeout can't charge twice.
    const res = await this.fetchWithRetry(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<OrderResponse>;
  }

  async getOrder(orderId: string): Promise<OrderStatus> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/orders/${orderId}`, {
      headers: { 'X-Api-Key': this.apiKey },
    });
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<OrderStatus>;
  }

  // Wait until the card is ready. Uses SSE (GET /orders/:id/stream) by
  // default — one open connection pushed to as the phase changes — and
  // falls back to HTTP polling if SSE fails for any reason (old backend,
  // hostile middlebox stripping text/event-stream, etc.).
  async waitForCard(
    orderId: string,
    { timeoutMs = 300000, intervalMs = 3000 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<CardDetails> {
    try {
      return await this.waitForCardStream(orderId, timeoutMs);
    } catch (err) {
      // Typed order-lifecycle errors must propagate unchanged — the stream
      // correctly reported a terminal failure / expiry / timeout.
      if (
        err instanceof OrderFailedError ||
        err instanceof WaitTimeoutError ||
        err instanceof Cards402ErrorCtor
      ) {
        throw err;
      }
      // Anything else (network, parse, 406, etc.) — fall back to polling.
      return this.waitForCardPoll(orderId, timeoutMs, intervalMs);
    }
  }

  // SSE fast path.
  private async waitForCardStream(orderId: string, timeoutMs: number): Promise<CardDetails> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/orders/${orderId}/stream`, {
        headers: { 'X-Api-Key': this.apiKey, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 404) throw new OrderFailedError(orderId, 'order_not_found', undefined);
        if (res.status === 401) throw new AuthErrorCtor();
        // Fall back to polling on any other non-2xx.
        throw new Error(`stream http ${res.status}`);
      }
      if (!res.body) throw new Error('stream has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on blank lines — each SSE event is terminated by \n\n.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          let payload: OrderStatus;
          try {
            payload = JSON.parse(json) as OrderStatus;
          } catch {
            continue;
          }

          if (payload.phase === 'ready' && payload.card) {
            return payload.card;
          }
          if (
            payload.phase === 'failed' ||
            payload.phase === 'refunded' ||
            payload.phase === 'rejected'
          ) {
            throw new OrderFailedError(orderId, payload.error ?? payload.phase, payload.refund);
          }
          if (payload.phase === 'expired') {
            throw new OrderFailedError(
              orderId,
              'Payment window expired — no funds were taken',
              undefined,
            );
          }
        }
      }
      // Stream ended without a terminal event — treat as timeout.
      throw new WaitTimeoutError(orderId, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  // Legacy polling path — kept as the fallback so old backends still work.
  private async waitForCardPoll(
    orderId: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<CardDetails> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const order = await this.getOrder(orderId);

      if (order.phase === 'ready' && order.card) return order.card;

      if (order.phase === 'failed' || order.phase === 'refunded' || order.phase === 'rejected') {
        throw new OrderFailedError(orderId, order.error ?? order.phase, order.refund);
      }

      if (order.phase === 'expired') {
        throw new OrderFailedError(
          orderId,
          'Payment window expired — no funds were taken',
          undefined,
        );
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new WaitTimeoutError(orderId, timeoutMs);
  }

  // List this agent's recent orders — useful for resuming after a crash.
  // Audit A-19: supports `since_created_at` / `since_updated_at` so agents
  // can poll for delta without re-fetching the full history.
  async listOrders({
    status,
    limit = 20,
    offset,
    since_created_at,
    since_updated_at,
  }: {
    status?: string;
    limit?: number;
    offset?: number;
    since_created_at?: string;
    since_updated_at?: string;
  } = {}): Promise<OrderListItem[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    if (since_created_at) params.set('since_created_at', since_created_at);
    if (since_updated_at) params.set('since_updated_at', since_updated_at);
    const qs = params.toString() ? `?${params}` : '';
    const res = await this.fetchWithRetry(`${this.baseUrl}/orders${qs}`, {
      headers: { 'X-Api-Key': this.apiKey },
    });
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<OrderListItem[]>;
  }

  // Get the agent's own spend and budget summary — useful for reporting to owners.
  async getUsage(): Promise<UsageSummary> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/usage`, {
      headers: { 'X-Api-Key': this.apiKey },
    });
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<UsageSummary>;
  }

  // Report a setup lifecycle transition to the backend. The owner's
  // admin dashboard and the agent's own dashboard subscribe to these
  // via SSE and show a live "onboarding state" pill, so operators can
  // see at a glance which agents are setting up, which are awaiting
  // deposits, and which are active.
  //
  // Valid states:
  //   'initializing'     — the agent is just starting setup
  //   'awaiting_funding' — wallet created, waiting for on-chain deposit
  //
  // 'minted' (never contacted) and 'active' (first delivered order) are
  // derived by the backend from activity, so you don't report those.
  //
  // Errors are swallowed: dashboard state is a best-effort signal, not
  // something that should break the purchase flow if the endpoint is
  // transiently unreachable.
  async reportStatus(
    state: 'initializing' | 'awaiting_funding',
    opts: { wallet_public_key?: string; detail?: string } = {},
  ): Promise<void> {
    try {
      await this.fetchWithRetry(`${this.baseUrl}/agent/status`, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state,
          wallet_public_key: opts.wallet_public_key,
          detail: opts.detail,
        }),
      });
    } catch {
      /* best-effort; do not block the caller */
    }
  }
}
