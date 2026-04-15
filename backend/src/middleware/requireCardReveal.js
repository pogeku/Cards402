// @ts-check
// Middleware for raw card-data reveal endpoints.
//
// Adversarial audit F4: before this, GET /internal/orders returned full
// PAN/CVV/expiry to anyone with an @cards402.com mailbox. That made every
// corporate inbox a potential card-data exfiltration vector. This middleware
// is strictly narrower than requireInternal: only emails listed in
// CARDS402_CARD_REVEAL_EMAILS can pass. If the env var is unset, NOBODY can
// reveal raw card data — fail-closed by design, because the safe default
// for PAN/CVV access is "no one".
//
// Must be used after requireAuth + requireInternal. Every successful reveal
// also writes an audit_log entry (handled in the route, not here, so the
// route can record the order_id being revealed).
//
// Adversarial audit 2026-04-15:
//
//   F1-card-reveal: denied and allowed attempts now emit a bizEvent so
//     ops has a push signal for every card-reveal authorization decision.
//     Pre-fix, a hostile or misconfigured operator hammering the reveal
//     endpoint left zero trace — the middleware silently returned 401/403
//     and the downstream route-level audit_log only ran on success, so
//     DENIED attempts were invisible in forensics. Now every decision
//     branches through a bizEvent with actor email, reason, IP, and UA
//     so the dashboard alerts engine can surface spikes in real time.
//
//   F3-card-reveal: the bizEvent call is wrapped in try/catch so a logger
//     or event-bus failure cannot alter the auth verdict. A downstream
//     subscriber that throws, a full stdout buffer, or an event-bus module
//     that fails to load must NOT flip a 403 into a 500 (which surfaces
//     as a server error and gives an attacker more info than a plain
//     authorization denial). Observability is strictly secondary to the
//     gate's correctness.

const { event: bizEvent } = require('../lib/logger');

function getCardRevealEmails() {
  const raw = process.env.CARDS402_CARD_REVEAL_EMAILS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * F3-card-reveal: safely emit a bizEvent without leaking a logger failure
 * into the auth verdict. Any throw from inside bizEvent (malformed payload,
 * stdout EPIPE during shutdown, event-bus subscriber crash) is swallowed
 * so the middleware's return value is determined solely by the auth logic.
 * @param {string} name
 * @param {Record<string, unknown>} fields
 */
function safeBizEvent(name, fields) {
  try {
    bizEvent(name, fields);
  } catch {
    /* intentional — observability must not block the gate */
  }
}

/**
 * Extract a single client IP string from the request. Delegates to req.ip
 * which Express sets from X-Forwarded-For (if trust proxy is on) or the
 * socket's remote address. Falls back to the X-Forwarded-For header string
 * or null if neither is available.
 * @param {any} req
 */
function clientIpOf(req) {
  if (typeof req.ip === 'string') return req.ip;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff;
  if (Array.isArray(xff) && typeof xff[0] === 'string') return xff[0];
  return null;
}

/**
 * Extract the user-agent header, coercing an array-valued header to its
 * first element (same defensive pattern as audit.js::recordAuditFromReq).
 * @param {any} req
 */
function userAgentOf(req) {
  const ua = req.headers && req.headers['user-agent'];
  if (typeof ua === 'string') return ua;
  if (Array.isArray(ua) && typeof ua[0] === 'string') return ua[0];
  return null;
}

module.exports = function requireCardReveal(req, res, next) {
  if (!req.user) {
    // No actor at all — emit under a best-effort 'unknown' label.
    safeBizEvent('card_reveal.denied', {
      reason: 'no_user',
      actor_email: null,
      ip: clientIpOf(req),
      user_agent: userAgentOf(req),
    });
    return res.status(401).json({ error: 'unauthenticated' });
  }

  // F2-card-reveal: defensive type check. requireAuth always populates
  // req.user.email from a NOT NULL UNIQUE column, but any future auth
  // middleware that sets req.user via a different code path would
  // trigger a TypeError on .toLowerCase() and cascade to 500. Fail
  // closed on a missing email instead of crashing.
  if (typeof req.user.email !== 'string' || req.user.email.length === 0) {
    safeBizEvent('card_reveal.denied', {
      reason: 'missing_email',
      actor_user_id: req.user?.id ?? null,
      actor_email: null,
      ip: clientIpOf(req),
      user_agent: userAgentOf(req),
    });
    return res.status(401).json({ error: 'unauthenticated', message: 'Missing email in session' });
  }

  const email = req.user.email.toLowerCase();
  const allowed = getCardRevealEmails();

  if (allowed.length === 0) {
    safeBizEvent('card_reveal.denied', {
      reason: 'env_not_configured',
      actor_user_id: req.user.id ?? null,
      actor_email: email,
      ip: clientIpOf(req),
      user_agent: userAgentOf(req),
    });
    return res.status(403).json({
      error: 'card_reveal_disabled',
      message:
        'Raw card reveal is disabled in this deployment. Set CARDS402_CARD_REVEAL_EMAILS to ' +
        'an explicit list of authorised operators to enable.',
    });
  }

  if (!allowed.includes(email)) {
    safeBizEvent('card_reveal.denied', {
      reason: 'not_in_allowlist',
      actor_user_id: req.user.id ?? null,
      actor_email: email,
      ip: clientIpOf(req),
      user_agent: userAgentOf(req),
    });
    return res.status(403).json({
      error: 'forbidden',
      message: 'Not authorised to reveal raw card data',
    });
  }

  // F1-card-reveal: observability on successful authorization too. The
  // downstream route writes an audit_log row with the order_id being
  // revealed, but that only fires if the route itself reaches that code
  // path. Emitting here guarantees every authorization decision has a
  // signal regardless of whether the route later crashes, times out, or
  // short-circuits on a second check.
  safeBizEvent('card_reveal.allowed', {
    actor_user_id: req.user.id ?? null,
    actor_email: email,
    ip: clientIpOf(req),
    user_agent: userAgentOf(req),
  });

  next();
};
