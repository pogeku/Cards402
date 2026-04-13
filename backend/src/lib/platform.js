// @ts-check
// Platform-owner identification.
//
// cards402 has two distinct authorities:
//
//   1. Dashboard-scoped roles (owner / admin / operator / viewer) live
//      inside a single tenant and govern what a logged-in user can do
//      with their own agents, orders, and settings. See lib/permissions.js.
//
//   2. The PLATFORM owner is whoever runs cards402 itself — the email
//      that should see system-level signals like CTX auth health and
//      the fulfillment circuit breaker. There is exactly one platform
//      owner per deployment, set via env, and it does NOT exist as a
//      database role because it's an attribute of the operator account
//      rather than of any individual dashboard.
//
// Without `CARDS402_PLATFORM_OWNER_EMAIL` set, no one is treated as the
// platform owner and system-level UI / endpoints stay locked down.

/**
 * @param {string | null | undefined} email
 * @returns {boolean}
 */
function isPlatformOwner(email) {
  const configured = process.env.CARDS402_PLATFORM_OWNER_EMAIL;
  if (!configured) return false;
  if (!email) return false;
  return email.trim().toLowerCase() === configured.trim().toLowerCase();
}

module.exports = { isPlatformOwner };
