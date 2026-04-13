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
const { buildBudget, policyCheck } = require('./api/orders');
const adminRouter = require('./api/admin');
const dashboardRouter = require('./api/dashboard');
const authRouter = require('./api/auth');
const internalRouter = require('./api/internal');
const vccCallbackRouter = require('./api/vcc-callback');

const app = express();

// B-13: Attach a unique request ID to every request for log correlation.
app.use((req, res, next) => {
  req.id = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 36);
  res.setHeader('X-Request-ID', req.id);
  log('info', 'request', { req_id: req.id, method: req.method, path: req.path });
  next();
});

/** @type {any} */ const helmetMiddleware = helmet;
app.use(helmetMiddleware());
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (/** @type {any} */ req) => ipKeyGenerator(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_, res) =>
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Too many requests. Wait a few minutes and try again.',
    }),
});

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

app.get('/status', (req, res) => {
  const frozen =
    /** @type {any} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'frozen'`).get())
      ?.value === '1';
  const failures = /** @type {any} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'consecutive_failures'`).get()
  )?.value;
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

  res.json({
    ok: !frozen,
    frozen,
    consecutive_failures: parseInt(failures || '0'),
    orders: { pending_payment: pendingCount, in_progress: inProgressCount },
  });
});

// All /v1/* routes require a valid API key
app.use('/v1', auth);

app.use('/v1/orders', ordersRouter);

// GET /v1/policy/check?amount=X — dry-run policy check without creating an order
app.get('/v1/policy/check', (req, res) => {
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
app.post('/v1/agent/status', (req, res) => {
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
    fields.push('agent_state_detail = @detail');
    params.detail = detail ? String(detail).slice(0, 500) : null;
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
app.get('/v1/usage', (req, res) => {
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

app.use('/auth', authLimiter, authRouter);
app.use('/dashboard', adminLimiter, dashboardRouter);
app.use('/admin', adminLimiter, adminRouter);
app.use('/internal', adminLimiter, internalRouter);
// VCC callback — HMAC-authenticated, no session required.
// Rate-limited generously to handle bursts while blocking floods.
const vccCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 500,
  keyGenerator: () => 'vcc-callback',
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
