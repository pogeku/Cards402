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
