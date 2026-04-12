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

  const email = req.user.email.toLowerCase();
  const allowedEmails = getAllowedEmails();

  const isAllowedDomain = email.endsWith(ALLOWED_DOMAIN);
  const isAllowedEmail = allowedEmails.includes(email);

  if (!isAllowedDomain && !isAllowedEmail) {
    return res.status(403).json({ error: 'forbidden', message: 'Internal access only' });
  }

  next();
};
