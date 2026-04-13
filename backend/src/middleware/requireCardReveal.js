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

function getCardRevealEmails() {
  const raw = process.env.CARDS402_CARD_REVEAL_EMAILS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = function requireCardReveal(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });

  const email = req.user.email.toLowerCase();
  const allowed = getCardRevealEmails();

  if (allowed.length === 0) {
    return res.status(403).json({
      error: 'card_reveal_disabled',
      message:
        'Raw card reveal is disabled in this deployment. Set CARDS402_CARD_REVEAL_EMAILS to ' +
        'an explicit list of authorised operators to enable.',
    });
  }

  if (!allowed.includes(email)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Not authorised to reveal raw card data',
    });
  }

  next();
};
