// @ts-check
// requirePlatformOwner — gates platform-wide cross-tenant endpoints.
//
// Must be chained after requireAuth (which populates req.user and
// stamps req.user.is_platform_owner based on CARDS402_PLATFORM_OWNER_EMAIL).
//
// Platform ownership is a deployment attribute, distinct from the
// per-dashboard role ('owner' | 'user') — there is exactly ONE platform
// owner per cards402 deployment, and only they see the cross-tenant
// surfaces under /dashboard/platform/*. See src/lib/platform.js.

module.exports = function requirePlatformOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (!req.user.is_platform_owner) {
    return res.status(403).json({ error: 'forbidden', message: 'Platform owner only' });
  }
  next();
};
