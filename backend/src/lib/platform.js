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
//
// Adversarial audit 2026-04-15:
//
//   F1-platform: defensive typeof check. The pre-fix `!email` guard
//     caught null / undefined / empty string but NOT truthy non-string
//     inputs — calling `email.trim()` on a number / boolean / object
//     throws TypeError. Today's single production caller (requireAuth.js:77)
//     passes a DB row email which is always a string, but the function
//     is exported with a permissive JSDoc signature and could be called
//     from anywhere. Fail closed on non-string instead of crashing.
//
//   F2-platform: fail closed when either side trims to empty. Pre-fix,
//     `'   '.trim().toLowerCase() === '   '.trim().toLowerCase()` is
//     `'' === ''` which is TRUE. If CARDS402_PLATFORM_OWNER_EMAIL was
//     a whitespace-only string AND the user's email trimmed to empty,
//     the helper returned TRUE — silent privilege escalation to
//     "platform owner for anyone with an empty email". env.js zod
//     validation blocks this in production (whitespace fails `.email()`),
//     but tests bypass env validation and a security-grade helper
//     should be self-protective. An empty-after-trim value is never
//     a legitimate identity match on either side.

/**
 * @param {string | null | undefined} email
 * @returns {boolean}
 */
function isPlatformOwner(email) {
  const configured = process.env.CARDS402_PLATFORM_OWNER_EMAIL;
  if (!configured) return false;
  // F1-platform: truthy non-string input would crash on .trim().
  if (typeof configured !== 'string') return false;
  if (typeof email !== 'string') return false;
  if (email.length === 0) return false;
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedConfigured = configured.trim().toLowerCase();
  // F2-platform: fail closed if either side collapses to empty after
  // trim. Prevents the "two empty strings match each other" case that
  // would otherwise return TRUE for any whitespace-only input.
  if (normalizedEmail.length === 0 || normalizedConfigured.length === 0) return false;
  return normalizedEmail === normalizedConfigured;
}

module.exports = { isPlatformOwner };
