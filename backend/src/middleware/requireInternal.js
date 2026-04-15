// @ts-check
// Middleware for /internal/* routes — only allows emails in INTERNAL_EMAILS env var
// or the @cards402.com domain. Must be used after requireAuth.

const ALLOWED_DOMAIN = '@cards402.com';

function getAllowedEmails() {
  const raw = process.env.INTERNAL_EMAILS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = function requireInternal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });

  // F1-require-internal: defensive type check on req.user.email. requireAuth
  // always populates it from a NOT NULL UNIQUE column in practice, but any
  // future auth code path that sets req.user without an email would cascade
  // a .toLowerCase() TypeError into a 500. Fail closed to 401 instead.
  // Same guard was added to requireCardReveal in the 2026-04-15 audit.
  if (typeof req.user.email !== 'string' || req.user.email.length === 0) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Missing email in session' });
  }

  const email = req.user.email.toLowerCase();
  const allowedEmails = getAllowedEmails();

  const isAllowedDomain = email.endsWith(ALLOWED_DOMAIN);
  const isAllowedEmail = allowedEmails.includes(email);

  if (!isAllowedDomain && !isAllowedEmail) {
    return res.status(403).json({ error: 'forbidden', message: 'Internal access only' });
  }

  next();
};
