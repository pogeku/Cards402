// @ts-check
// SSRF protection — blocks webhook URLs that resolve to private/internal IPs.
// Always call this before fetching a user-supplied URL.

const dns = require('dns').promises;
const net = require('net');

// RFC-1918 private ranges + loopback + link-local + CGNAT + IPv6 equivalents
const BLOCKED = [
  /^127\./,                          // loopback
  /^0\./,                            // unspecified
  /^10\./,                           // RFC-1918
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC-1918
  /^192\.168\./,                     // RFC-1918
  /^169\.254\./,                     // link-local / AWS metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT RFC-6598
  /^::1$/,                           // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,               // IPv6 ULA
  /^fd[0-9a-f]{2}:/i,               // IPv6 ULA
  /^fe80:/i,                         // IPv6 link-local
];

function isPrivateIp(ip) {
  return BLOCKED.some(r => r.test(ip));
}

/**
 * Validates that a URL is safe to fetch as a webhook target.
 * - Blocks private/internal IP ranges (SSRF)
 * - Enforces HTTPS in production
 *
 * Returns { address, family } of the resolved IP so the caller can pin the
 * connection to that IP, eliminating the DNS rebinding window (B-6).
 * Returns null for IP-literal hostnames (already validated inline).
 *
 * Throws if the URL is unsafe.
 */
async function assertSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid webhook URL: ${urlString}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid webhook URL protocol: ${url.protocol} — only http/https allowed`);
  }

  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS in production');
  }

  // Strip brackets from IPv6 literals: '[::1]' → '::1'
  const hostname = url.hostname.replace(/^\[(.+)\]$/, '$1');

  // If hostname is already an IP literal, check it directly and return null
  // (no DNS round-trip needed — the IP is already known)
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Webhook URL resolves to a private IP (${hostname}) — blocked`);
    }
    return null;
  }

  // Resolve DNS and validate every returned address
  try {
    const result = await dns.lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw new Error(`Webhook URL resolves to a private IP (${address}) — blocked`);
      }
    }
    // Return the first resolved address so callers can pin the connection
    return addresses[0] ?? null;
  } catch (err) {
    if (err.message.includes('blocked')) throw err;
    throw new Error(`Webhook URL DNS resolution failed: ${err.message}`);
  }
}

module.exports = { assertSafeUrl };
