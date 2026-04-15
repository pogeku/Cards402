// @ts-check
// SSRF protection — blocks webhook URLs that resolve to private/internal IPs.
// Always call this before fetching a user-supplied URL.
//
// We use Node's built-in net.BlockList instead of hand-rolled regexes
// because it handles CIDR math correctly and covers a few edge cases
// the old regex list missed (fe80::/10 past fe80, multicast, reserved,
// 255.255.255.255, and so on). The old regex list is kept only as a
// mental index — every entry below is equivalent to a CIDR subnet.

const dns = require('dns').promises;
const net = require('net');

const blockList = new net.BlockList();

// ── IPv4 blocked ranges ──────────────────────────────────────────────────────
// 0.0.0.0/8           "this network" (RFC 1122)
// 10.0.0.0/8          RFC 1918 private
// 100.64.0.0/10       CGNAT (RFC 6598)
// 127.0.0.0/8         loopback
// 169.254.0.0/16      link-local + AWS/GCP metadata (169.254.169.254)
// 172.16.0.0/12       RFC 1918 private
// 192.0.0.0/24        IETF protocol assignments (RFC 6890)
// 192.0.2.0/24        docs TEST-NET-1 (RFC 5737)
// 192.168.0.0/16      RFC 1918 private
// 198.18.0.0/15       benchmarking (RFC 2544)
// 198.51.100.0/24     docs TEST-NET-2 (RFC 5737)
// 203.0.113.0/24      docs TEST-NET-3 (RFC 5737)
// 224.0.0.0/4         multicast (RFC 5771)
// 240.0.0.0/4         reserved + 255.255.255.255 broadcast
blockList.addSubnet('0.0.0.0', 8);
blockList.addSubnet('10.0.0.0', 8);
blockList.addSubnet('100.64.0.0', 10);
blockList.addSubnet('127.0.0.0', 8);
blockList.addSubnet('169.254.0.0', 16);
blockList.addSubnet('172.16.0.0', 12);
blockList.addSubnet('192.0.0.0', 24);
blockList.addSubnet('192.0.2.0', 24);
blockList.addSubnet('192.168.0.0', 16);
blockList.addSubnet('198.18.0.0', 15);
blockList.addSubnet('198.51.100.0', 24);
blockList.addSubnet('203.0.113.0', 24);
blockList.addSubnet('224.0.0.0', 4);
blockList.addSubnet('240.0.0.0', 4);

// ── IPv6 blocked ranges ──────────────────────────────────────────────────────
// ::/128              unspecified address
// ::1/128             loopback
// fc00::/7            unique local addresses (ULA) — covers fc00:: and fd00::
// fe80::/10           link-local — covers fe80:: through febf::
// ff00::/8            multicast
// 2001:db8::/32       documentation prefix (RFC 3849)
//
// Translation / tunneling prefixes (F1 adversarial audit). Each of these
// encodes or routes to an IPv4 address that would bypass our IPv4
// blocklist if left unchecked, because the check runs on the IPv6 form:
//
// 2002::/16           6to4 tunneling (RFC 3056). 2002:<IPv4-hex>::/48
//                     encapsulates the embedded IPv4 via 6to4 relays.
//                     Example: 2002:7f00:0001:: → routes to 127.0.0.1.
//                     Deprecated by RFC 7526 (2015) but still routable
//                     on older stacks.
// 2001::/32           Teredo tunneling (RFC 4380). Bytes 10-13 encode
//                     a NAT-obfuscated IPv4. Legacy, mostly dead on
//                     modern Linux, but block defensively.
// 64:ff9b::/96        NAT64 well-known prefix (RFC 6052). Last 32 bits
//                     are an IPv4 that the NAT64 translator will
//                     route to. Example: 64:ff9b::7f00:1 → 127.0.0.1.
//                     Not deployed on most hosts but present on
//                     dual-stack networks running NAT64/DNS64.
// ::/96               IPv4-compatible IPv6 addresses (RFC 4291 §2.5.5.1).
//                     Deprecated form where an IPv4 is embedded at the
//                     low 32 bits WITHOUT the ::ffff: marker — e.g.
//                     ::7f00:1 or ::127.0.0.1. Modern stacks don't
//                     route these as loopback (unlike the ::ffff:*
//                     IPv4-mapped form), but older kernels and some
//                     dual-stack NAT64 paths still process them. The
//                     regex-based IPv4-mapped fallback in isPrivateIp
//                     below only catches `::ffff:*`, so this subnet
//                     is the wholesale block for the compatible form.
//                     F1-ssrf adversarial audit (2026-04-15).
blockList.addAddress('::', 'ipv6');
blockList.addAddress('::1', 'ipv6');
blockList.addSubnet('::', 96, 'ipv6');
blockList.addSubnet('fc00::', 7, 'ipv6');
blockList.addSubnet('fe80::', 10, 'ipv6');
blockList.addSubnet('ff00::', 8, 'ipv6');
blockList.addSubnet('2001:db8::', 32, 'ipv6');
blockList.addSubnet('2002::', 16, 'ipv6');
blockList.addSubnet('2001::', 32, 'ipv6');
blockList.addSubnet('64:ff9b::', 96, 'ipv6');

/**
 * Check whether an IP string (v4 or v6) falls inside any blocked range.
 *
 * Handles IPv4-mapped IPv6 (::ffff:X.X.X.X and its hex variants) by
 * extracting the embedded IPv4 and checking that too — otherwise an
 * attacker could sneak a URL like `http://[::ffff:127.0.0.1]/` past a
 * naive IPv6-only check against the IPv4 loopback range.
 */
function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) {
    // Direct IPv6 check first.
    if (blockList.check(ip, 'ipv6')) return true;
    // IPv4-mapped IPv6 canonical form: ::ffff:a.b.c.d
    const mapped = ip.match(/:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mapped && net.isIP(mapped[1]) === 4) {
      return blockList.check(mapped[1], 'ipv4');
    }
    // IPv4-mapped IPv6 hex form: ::ffff:XXXX:YYYY → each 16-bit group
    // encodes two IPv4 octets. The regex pulls the last two groups
    // out of any fully-expanded or compressed form ending in ffff:…
    const hexMapped = ip.match(/:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const asV4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        if (net.isIP(asV4) === 4 && blockList.check(asV4, 'ipv4')) return true;
      }
    }
    return false;
  }
  // Not a valid IP at all — refuse.
  return true;
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

  // Resolve DNS. Scope this try/catch ONLY around the lookup call so
  // the private-IP throw further down can propagate unchanged instead
  // of routing through a substring-matching rethrow. F2-ssrf adversarial
  // audit (2026-04-15): the previous structure used
  //   if (err.message.includes('blocked')) throw err;
  //   else throw new Error(`DNS resolution failed: ${err.message}`);
  // which silently misclassified blocked throws if anyone ever edited
  // the "blocked" error message. Splitting the blocks eliminates the
  // substring-matching coupling.
  let addresses;
  try {
    const result = await dns.lookup(hostname, { all: true });
    addresses = Array.isArray(result) ? result : [result];
  } catch (err) {
    throw new Error(`Webhook URL DNS resolution failed: ${err.message}`);
  }

  // F3-ssrf adversarial audit (2026-04-15): an empty result array must
  // be an error, not a silent "no private IPs found → approved". In
  // practice `dns.lookup` throws ENOTFOUND for unresolvable hosts so
  // this branch is a defensive guard, but a silent approval path would
  // let a caller proceed to fetch() without having checked anything.
  if (addresses.length === 0) {
    throw new Error(`Webhook URL DNS returned no addresses for ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`Webhook URL resolves to a private IP (${address}) — blocked`);
    }
  }
  // Return the first resolved address so callers can pin the connection
  return addresses[0] ?? null;
}

module.exports = { assertSafeUrl };
