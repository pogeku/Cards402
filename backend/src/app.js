// @ts-check
// Express application — importable without starting the Stellar watcher or jobs.
// index.js is the entry point that wires everything up for production.

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const { log } = require('./lib/logger');
const auth = require('./middleware/auth');
const ordersRouter = require('./api/orders');
const { buildBudget, policyCheck, orderPollLimiter } = require('./api/orders');
// Legacy /admin/* router was retired with the ampersand dashboard rewrite.
// The new /dashboard surface (mounted below) is the canonical operator API
// and is what /api/admin-proxy on the web app forwards to.
const dashboardRouter = require('./api/dashboard');
const authRouter = require('./api/auth');
const internalRouter = require('./api/internal');
const platformRouter = require('./api/platform');
const vccCallbackRouter = require('./api/vcc-callback');
const { MAX_WEBHOOK_ATTEMPTS: MAX_WEBHOOK_ATTEMPTS_FOR_STATUS } = require('./fulfillment');

const app = express();

// B-13: Attach a unique request ID to every request for log correlation.
app.use((req, res, next) => {
  req.id = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 36);
  res.setHeader('X-Request-ID', req.id);
  log('info', 'request', { req_id: req.id, method: req.method, path: req.path });
  next();
});

/** @type {any} */ const helmetMiddleware = helmet;
// helmet defaults are fine for everything except the HSTS header — the
// built-in default is max-age=15552000 (180 days) with no `preload`
// directive, which is too short to qualify for the Chrome HSTS preload
// list. Bump to two years + preload so api.cards402.com can be
// submitted to hstspreload.org and every browser refuses plaintext
// even on first visit. frameguard stays at SAMEORIGIN (API JSON
// responses don't need to be embeddable anywhere).
app.use(
  helmetMiddleware({
    hsts: {
      maxAge: 63072000, // 2 years
      includeSubDomains: true,
      preload: true,
    },
  }),
);
app.set('trust proxy', 1);

// Audit A-25: require HTTPS in non-development environments. A misconfigured
// production deploy that terminates plaintext (e.g. behind a load balancer
// forwarding HTTP) would otherwise ship API keys over the wire unencrypted.
// Honors `X-Forwarded-Proto` because `trust proxy` is set above, so a TLS
// terminator in front (Cloudflare, nginx, ALB) works correctly.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https') {
      return res.status(426).json({
        error: 'https_required',
        message: 'This endpoint requires HTTPS. Retry over https://',
      });
    }
    next();
  });
}

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('CORS: origin not allowed'));
    },
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization', 'Idempotency-Key'],
    maxAge: 3600,
  }),
);

// Capture raw body for HMAC signature verification (used by /vcc-callback)
app.use(
  express.json({
    limit: '64kb',
    verify: (/** @type {any} */ req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) => res.status(429).json({ error: 'too_many_requests' }),
});

// Note: /auth/login and /auth/verify carry their own per-path rate
// limiters in api/auth.js. We used to mount a blanket `authLimiter`
// here covering every /auth/* endpoint at 10 req / 15 min / IP, but
// that also gated /auth/me — the pure session-read the dashboard
// layout calls on every hard refresh — and produced 429s for users
// sharing a NAT'd network while doing nothing brute-forceable. The
// limiters now live inside the auth router so only the mutating
// endpoints (minting codes, verifying codes) get throttled.

// Audit C-9: API version endpoint for deploy-time compatibility checks.
const versionLimiter = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.get('/api/version', versionLimiter, (_req, res) => {
  res.json({
    service: 'cards402',
    version: '0.1.0',
    hmac_protocol: 'v3',
    features: ['idempotency_key', 'soroban_contract', 'webhook_circuit_breaker', 'callback_nonce'],
  });
});

// POST /v1/agent/claim — unauthenticated one-shot claim endpoint.
// The agent posts a code minted by the dashboard; we return the real
// api_key once, then mark the code used so it can never be redeemed
// again. Heavily rate-limited by IP because this is the one endpoint
// on /v1 that doesn't require an api key.
const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) =>
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many claim attempts. Wait a minute and try again.',
    }),
});
app.post('/v1/agent/claim', claimLimiter, (req, res) => {
  const { event: bizEvent } = require('./lib/logger');
  const secretBox = require('./lib/secret-box');
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    return res.status(400).json({ error: 'missing_code', message: 'code is required' });
  }

  // Atomic claim: UPDATE … WHERE used_at IS NULL returns 1 iff the row
  // moved from unused → used. Second concurrent request gets 0 rows and
  // falls through to the "invalid/expired/already used" branch. Same
  // generic error for all three so probing can't reveal which bucket a
  // stolen code is in.
  const now = new Date().toISOString();
  const ip =
    /** @type {any} */ (req).ip || /** @type {any} */ (req).connection?.remoteAddress || null;
  const update = db
    .prepare(
      `
    UPDATE agent_claims
    SET used_at = @now, claimed_ip = @ip
    WHERE code = @code
      AND used_at IS NULL
      AND datetime(expires_at) > datetime('now')
  `,
    )
    .run({ code, now, ip });

  if (update.changes === 0) {
    return res.status(401).json({
      error: 'invalid_claim',
      message: 'Claim code is invalid, expired, or already used.',
    });
  }

  // Pull the sealed payload that belongs to the now-consumed claim,
  // decrypt it, and also wipe the sealed payload from the row so the
  // api_key can never be re-extracted even if the DB is dumped later.
  const row = /** @type {any} */ (
    db.prepare(`SELECT api_key_id, sealed_payload FROM agent_claims WHERE code = ?`).get(code)
  );
  if (!row) {
    // Shouldn't happen — we just successfully updated that row.
    return res.status(500).json({ error: 'claim_inconsistent' });
  }

  let payload;
  try {
    payload = JSON.parse(secretBox.open(row.sealed_payload));
  } catch (err) {
    return res.status(500).json({
      error: 'claim_decrypt_failed',
      message:
        err instanceof Error && err.message.includes('CARDS402_SECRET_BOX_KEY')
          ? 'Server misconfigured: CARDS402_SECRET_BOX_KEY not set.'
          : 'Failed to decrypt claim payload.',
    });
  }
  db.prepare(`UPDATE agent_claims SET sealed_payload = '' WHERE code = ?`).run(code);

  const key = /** @type {any} */ (
    db.prepare(`SELECT id, label FROM api_keys WHERE id = ?`).get(row.api_key_id)
  );

  // Flip the key into 'initializing' state the instant the claim is
  // redeemed, so the dashboard's modal + state pill progress even if the
  // agent's CLI hasn't yet gotten to its own reportStatus call (network
  // lag, CLI crash between claim and wallet creation, etc.).
  db.prepare(
    `UPDATE api_keys
     SET agent_state = 'initializing',
         agent_state_at = @at,
         agent_state_detail = 'claim redeemed'
     WHERE id = @id`,
  ).run({ id: row.api_key_id, at: now });

  // Emit both a generic claim event (for audit) and the typed
  // agent_state event (for the SSE subscribers filtering by type).
  bizEvent('agent.claimed', {
    api_key_id: row.api_key_id,
    label: key?.label ?? null,
    ip,
  });
  const { emit: emitBusEvent } = require('./lib/event-bus');
  emitBusEvent('agent_state', {
    api_key_id: row.api_key_id,
    state: 'initializing',
    wallet_public_key: null,
    detail: 'claim redeemed',
  });

  res.json({
    api_key: payload.api_key,
    webhook_secret: payload.webhook_secret ?? null,
    api_key_id: row.api_key_id,
    label: key?.label ?? null,
    api_url: process.env.PUBLIC_API_BASE_URL || 'https://api.cards402.com/v1',
  });
});

// ── Public /status endpoint ───────────────────────────────────────────────────
//
// Powers both the dashboard banner and the public status page at
// cards402.com/status (and status.cards402.com via the proxy rewrite).
// Aims to be cheap enough to hit every 10–30s without load concerns:
// all queries are indexed and bounded to time windows.
//
// Still wants a per-IP limiter so an attacker can't turn the public
// /status endpoint into a cheap SQLite thrasher — the handler runs
// six COUNT/SUM queries on every hit and is unauthenticated. 180/min
// per IP is ~3 req/s, generous for multi-tab dashboards behind NAT
// but tight enough to cap a hostile loop.
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) => res.status(429).json({ error: 'too_many_requests' }),
});

const PROCESS_STARTED_AT = Date.now();

/** Read a system_state row by key, parse as int, default to 0. */
function sysStateInt(key) {
  const row = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(key)
  );
  return parseInt(row?.value || '0', 10) || 0;
}

app.get('/status', statusLimiter, (req, res) => {
  const frozen =
    /** @type {any} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get())
      ?.value === '1';
  const consecutiveFailures = sysStateInt('consecutive_failures');

  const pendingCount =
    /** @type {any} */ (
      db.prepare(`SELECT COUNT(*) as n FROM orders WHERE status = 'pending_payment'`).get()
    )?.n ?? 0;
  const inProgressCount =
    /** @type {any} */ (
      db
        .prepare(
          `SELECT COUNT(*) as n FROM orders WHERE status IN ('ordering','payment_confirmed','claim_received','stage1_done')`,
        )
        .get()
    )?.n ?? 0;
  const refundPendingCount =
    /** @type {any} */ (
      db.prepare(`SELECT COUNT(*) as n FROM orders WHERE status = 'refund_pending'`).get()
    )?.n ?? 0;

  // Rolling 24h counts by terminal state. Indexed on created_at so this
  // is a range scan of the last day's rows — typically a few hundred.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const last24hRow = /** @type {any} */ (
    db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN status = 'delivered'      THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'failed'         THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'refunded'       THEN 1 ELSE 0 END) AS refunded,
        SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END) AS refund_pending,
        SUM(CASE WHEN status = 'expired'        THEN 1 ELSE 0 END) AS expired,
        COUNT(*) AS total
      FROM orders
      WHERE created_at >= ?
    `,
      )
      .get(since24h)
  );
  const delivered24h = last24hRow?.delivered ?? 0;
  const failed24h = last24hRow?.failed ?? 0;
  const refunded24h = last24hRow?.refunded ?? 0;
  const expired24h = last24hRow?.expired ?? 0;
  const total24h = last24hRow?.total ?? 0;
  // Success rate: delivered over (delivered + failed + refunded). Excludes
  // expired orders (agent abandoned) and pending rows (not yet terminal).
  const terminal24h = delivered24h + failed24h + refunded24h;
  const successRate24h = terminal24h > 0 ? delivered24h / terminal24h : null;

  // Stellar watcher freshness. `stellar_start_ledger` advances as the
  // watcher persists its cursor; `stellar_start_ledger_at` captures the
  // wall clock of that update. If the age exceeds ~60s we consider the
  // watcher stalled. Both rows are upserted together in saveStartLedger.
  const lastLedger = sysStateInt('stellar_start_ledger');
  const lastLedgerAtRow = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'stellar_start_ledger_at'`).get()
  );
  const lastLedgerAt = lastLedgerAtRow?.value || null;
  const lastLedgerAgeSeconds = lastLedgerAt
    ? Math.round((Date.now() - new Date(lastLedgerAt).getTime()) / 1000)
    : null;

  // Silent-failure visibility counters (audit topic: observability).
  //
  // stellar_dead_letter: on-chain events the watcher couldn't parse.
  // Non-zero means the watcher saw an event that won't match any
  // pending order — someone (ops) needs to investigate the raw_event
  // rows and either reconcile manually or refund.
  //
  // webhooks_failed_permanently: rows left in webhook_queue with
  // attempts >= MAX_WEBHOOK_ATTEMPTS and delivered = 0. Before the
  // /status surface, these accumulated silently and only surfaced
  // when ops happened to query the table by hand (which is how the
  // outbound-TLS bug was found). Now it's a first-class health signal.
  const stellarDeadLetter24h =
    /** @type {any} */ (
      db
        .prepare(`SELECT COUNT(*) AS n FROM stellar_dead_letter WHERE created_at >= ?`)
        .get(since24h)
    )?.n ?? 0;
  const webhooksFailedPermanent24h =
    /** @type {any} */ (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM webhook_queue
           WHERE delivered = 0 AND attempts >= ? AND created_at >= ?`,
        )
        .get(MAX_WEBHOOK_ATTEMPTS_FOR_STATUS, since24h)
    )?.n ?? 0;

  res.json({
    ok:
      !frozen &&
      consecutiveFailures < 3 &&
      stellarDeadLetter24h === 0 &&
      webhooksFailedPermanent24h < 5,
    frozen,
    consecutive_failures: consecutiveFailures,
    orders: {
      pending_payment: pendingCount,
      in_progress: inProgressCount,
      refund_pending: refundPendingCount,
    },
    last_24h: {
      total: total24h,
      delivered: delivered24h,
      failed: failed24h,
      refunded: refunded24h,
      expired: expired24h,
      success_rate: successRate24h, // 0..1 or null if no terminal orders
    },
    stellar_watcher: {
      last_ledger: lastLedger || null,
      last_ledger_at: lastLedgerAt,
      age_seconds: lastLedgerAgeSeconds,
      dead_letter_24h: stellarDeadLetter24h,
    },
    webhooks: {
      failed_permanent_24h: webhooksFailedPermanent24h,
    },
    process: {
      uptime_seconds: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
      started_at: new Date(PROCESS_STARTED_AT).toISOString(),
    },
    generated_at: new Date().toISOString(),
  });
});

// All /v1/* routes require a valid API key
app.use('/v1', auth);

app.use('/v1/orders', ordersRouter);

// GET /v1/policy/check?amount=X — dry-run policy check without creating an order
// Runs a SUM over orders per request, so it needs the same per-key
// throttle as /v1/orders polling. Before this limiter was added, a
// compromised key could enumerate the owner's daily spend and bruteforce
// policy thresholds without burning order-creation budget.
app.get('/v1/policy/check', orderPollLimiter, (req, res) => {
  const amount = String(req.query.amount || '');
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res
      .status(400)
      .json({ error: 'invalid_amount', message: 'Query param ?amount= must be a positive number' });
  }
  return res.json(policyCheck(req.apiKey.id, parseFloat(amount)));
});

// POST /v1/agent/status — agent reports setup / lifecycle transitions.
// Drives the live "onboarding state" pill in the dashboards. Idempotent:
// an agent can POST the same state repeatedly without side-effects.
//
// Every POST emits a bizEvent and fans out an agent_state event on the
// in-process bus, which the dashboard SSE stream picks up and relays to
// every connected browser. Without a limiter, an agent stuck in a tight
// loop (or a compromised key) could flood the bus and 100% the SSE fan-out.
// 60/min per key is ~20× the real workload — an agent only transitions
// through ~4 states over onboarding and rarely reports afterwards.
const agentStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (/** @type {any} */ req) =>
    /** @type {any} */ (req).apiKey?.id || ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) => res.status(429).json({ error: 'too_many_requests' }),
});
app.post('/v1/agent/status', agentStatusLimiter, (req, res) => {
  const { emit: emitBusEvent } = require('./lib/event-bus');
  const ALLOWED_STATES = new Set(['initializing', 'awaiting_funding', 'funded']);
  const { state, wallet_public_key, detail } = req.body || {};

  if (state !== undefined && !ALLOWED_STATES.has(state)) {
    return res.status(400).json({
      error: 'invalid_state',
      message: `state must be one of: ${[...ALLOWED_STATES].join(', ')} (the 'minted' and 'active' states are derived automatically from activity)`,
    });
  }
  if (wallet_public_key !== undefined && wallet_public_key !== null) {
    if (!/^G[A-Z2-7]{55}$/.test(wallet_public_key)) {
      return res.status(400).json({
        error: 'invalid_wallet_public_key',
        message: 'wallet_public_key must be a valid Stellar G-address (56 chars, starts with G)',
      });
    }
  }

  const fields = [];
  const params = { id: req.apiKey.id, at: new Date().toISOString() };
  if (state !== undefined) {
    fields.push('agent_state = @state', 'agent_state_at = @at');
    params.state = state;
  }
  if (wallet_public_key !== undefined) {
    fields.push('wallet_public_key = @wallet_public_key');
    params.wallet_public_key = wallet_public_key || null;
  }
  if (detail !== undefined) {
    // Reject non-string detail — without the typeof guard an object
    // coerces to "[object Object]" via String(), which passes the length
    // check but stores a nonsense row in agent_state_detail.
    if (detail !== null && typeof detail !== 'string') {
      return res.status(400).json({
        error: 'invalid_detail',
        message: 'detail must be a string or null',
      });
    }
    fields.push('agent_state_detail = @detail');
    params.detail = detail ? detail.slice(0, 500) : null;
  }
  if (fields.length === 0) {
    return res.status(400).json({
      error: 'nothing_to_update',
      message: 'Provide at least one of: state, wallet_public_key, detail',
    });
  }

  db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = @id`).run(params);

  emitBusEvent('agent_state', {
    api_key_id: req.apiKey.id,
    state: state ?? null,
    wallet_public_key: wallet_public_key ?? null,
    detail: detail ?? null,
  });

  res.json({ ok: true });
});

// GET /v1/usage — agent's own spend and order summary
// Runs COUNT + SUM over orders. Same per-key throttle as the rest of
// the agent read surface.
app.get('/v1/usage', orderPollLimiter, (req, res) => {
  const counts = db
    .prepare(
      `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded,
      SUM(CASE WHEN status NOT IN ('delivered','failed','refunded') THEN 1 ELSE 0 END) AS in_progress
    FROM orders WHERE api_key_id = ?
  `,
    )
    .get(req.apiKey.id);
  res.json({
    api_key_id: req.apiKey.id,
    label: req.apiKey.label,
    budget: buildBudget(req.apiKey),
    orders: counts,
  });
});

app.use('/auth', authRouter);
// Platform-owner cross-tenant surface. Mounted BEFORE /dashboard so its
// prefix catches /dashboard/platform/* before the tenant-scoped
// dashboard router sees it. Gated by requirePlatformOwner inside the
// router so only the deployment's platform owner can hit these routes.
app.use('/dashboard/platform', adminLimiter, platformRouter);
app.use('/dashboard', adminLimiter, dashboardRouter);
app.use('/internal', adminLimiter, internalRouter);
// VCC callback — HMAC-authenticated, no session required.
//
// Bucket by client IP (the default keyGenerator) rather than a single
// global key. The earlier version used `() => 'vcc-callback'` which
// collapsed every caller into one shared counter — an attacker flooding
// the endpoint would exhaust the limit and lock out legitimate VCC
// fulfillment callbacks from the real service. `trust proxy` is set to
// 1 above, so req.ip resolves to the real client IP via X-Forwarded-For
// and legitimate traffic from the VCC service (one origin) stays well
// under the ceiling while single-IP floods get rate-limited on their
// own counter instead of starving everyone else.
//
// 120/min per IP = 2/sec, comfortably above the steady-state rate of
// legitimate callbacks (one per order, bursting rarely past a handful
// per minute) and tight enough that a single attacker can't saturate
// the endpoint's CPU.
const vccCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) => res.status(429).json({ error: 'too_many_requests' }),
});
app.use('/vcc-callback', vccCallbackLimiter, vccCallbackRouter);

// Structured CORS denial — cors() throws on rejected origins; catch and return clean 403
app.use((err, req, res, _next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
  }
  console.error('[app] unhandled error:', err.message);
  res.status(500).json({ error: 'internal_error' });
});

module.exports = app;
