require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeUrl } = require('../../src/lib/ssrf');

describe('assertSafeUrl — SSRF protection', () => {
  // ── Private IP ranges ──────────────────────────────────────────────────────

  it('blocks loopback 127.0.0.1', async () => {
    await assert.rejects(() => assertSafeUrl('http://127.0.0.1/payload'), /private IP/);
  });

  it('blocks RFC-1918 10.x', async () => {
    await assert.rejects(() => assertSafeUrl('http://10.0.0.1/payload'), /private IP/);
  });

  it('blocks RFC-1918 172.16.x', async () => {
    await assert.rejects(() => assertSafeUrl('http://172.16.0.1/payload'), /private IP/);
  });

  it('blocks RFC-1918 172.31.x', async () => {
    await assert.rejects(() => assertSafeUrl('http://172.31.255.255/payload'), /private IP/);
  });

  it('allows 172.32.x (not private)', async () => {
    // 172.32 is outside the RFC-1918 range — DNS will fail but no SSRF block
    // We just test the IP range logic by constructing a URL with a known IP
    // Since DNS will fail for a made-up hostname, test direct IP instead
    // 172.32.0.1 is public — should not throw a "private IP" error
    // (it may throw a DNS error, which is acceptable)
    try {
      await assertSafeUrl('http://172.32.0.1/test');
      // if no throw, fine
    } catch (err) {
      assert.ok(
        !err.message.includes('private IP'),
        `Should not block 172.32.x as private: ${err.message}`,
      );
    }
  });

  it('blocks RFC-1918 192.168.x', async () => {
    await assert.rejects(() => assertSafeUrl('http://192.168.1.1/payload'), /private IP/);
  });

  it('blocks link-local / AWS metadata 169.254.x', async () => {
    await assert.rejects(
      () => assertSafeUrl('http://169.254.169.254/latest/meta-data/'),
      /private IP/,
    );
  });

  it('blocks IPv6 loopback ::1', async () => {
    await assert.rejects(() => assertSafeUrl('http://[::1]/payload'), /private IP/);
  });

  // ── IPv6 edge cases — regression guards for the 2026-04-14 audit ──────────

  it('blocks IPv6 unspecified ::', async () => {
    await assert.rejects(() => assertSafeUrl('http://[::]/payload'), /private IP/);
  });

  it('blocks IPv6 ULA fc00:', async () => {
    await assert.rejects(() => assertSafeUrl('http://[fc00::1]/payload'), /private IP/);
  });

  it('blocks IPv6 ULA fd00:', async () => {
    await assert.rejects(() => assertSafeUrl('http://[fd12:3456:789a::1]/payload'), /private IP/);
  });

  it('blocks IPv6 link-local fe80:', async () => {
    await assert.rejects(() => assertSafeUrl('http://[fe80::1]/payload'), /private IP/);
  });

  it('blocks IPv6 link-local fe8f: (was missed by old fe80:-only regex)', async () => {
    await assert.rejects(() => assertSafeUrl('http://[fe8f::1]/payload'), /private IP/);
  });

  it('blocks IPv6 link-local feb0: (top of fe80::/10)', async () => {
    await assert.rejects(() => assertSafeUrl('http://[feb0::1]/payload'), /private IP/);
  });

  it('blocks IPv6 multicast ff00:', async () => {
    await assert.rejects(() => assertSafeUrl('http://[ff02::1]/payload'), /private IP/);
  });

  it('blocks IPv6 docs prefix 2001:db8::', async () => {
    await assert.rejects(() => assertSafeUrl('http://[2001:db8::1]/payload'), /private IP/);
  });

  it('blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', async () => {
    // Attack vector: IPv4 loopback encoded as mapped IPv6 bypasses a
    // naive IPv6-only check. canonicalizeIp in ssrf.js should route
    // this to the IPv4 loopback range.
    await assert.rejects(() => assertSafeUrl('http://[::ffff:127.0.0.1]/payload'), /private IP/);
  });

  it('blocks IPv4-mapped IPv6 AWS metadata ::ffff:169.254.169.254', async () => {
    await assert.rejects(
      () => assertSafeUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'),
      /private IP/,
    );
  });

  it('blocks IPv4-mapped IPv6 RFC-1918 ::ffff:10.0.0.1', async () => {
    await assert.rejects(() => assertSafeUrl('http://[::ffff:10.0.0.1]/payload'), /private IP/);
  });

  // ── IPv6 translation / tunneling prefixes (2026-04-15 audit) ──────────────
  //
  // Each of these encodes or routes to an IPv4 address. A naive block-
  // list that only covered IPv4 private ranges + fc00::/fe80::/ff00::
  // would pass the IPv6 form through unchecked, and the kernel-level
  // tunneling / NAT64 path would deliver the packet to the embedded
  // IPv4. Regression guards for F1 of the ssrf.js audit.

  it('blocks 6to4 tunnel 2002::/16 (encodes IPv4 at bytes 2-5)', async () => {
    // 2002:7f00:0001::1 → encodes 127.0.0.1 via 6to4 tunneling (RFC 3056)
    await assert.rejects(() => assertSafeUrl('http://[2002:7f00:0001::1]/payload'), /private IP/);
  });

  it('blocks 6to4 tunnel 2002::/16 targeting AWS metadata', async () => {
    // 2002:a9fe:a9fe::1 → encodes 169.254.169.254
    await assert.rejects(() => assertSafeUrl('http://[2002:a9fe:a9fe::1]/payload'), /private IP/);
  });

  it('blocks Teredo tunnel 2001::/32', async () => {
    await assert.rejects(
      () => assertSafeUrl('http://[2001:0:53aa:64c:0:0:0:1]/payload'),
      /private IP/,
    );
  });

  it('blocks NAT64 well-known prefix 64:ff9b::/96', async () => {
    // 64:ff9b::7f00:1 → NAT64-routes to 127.0.0.1
    await assert.rejects(() => assertSafeUrl('http://[64:ff9b::7f00:1]/payload'), /private IP/);
  });

  it('blocks NAT64 well-known prefix targeting 10.0.0.1', async () => {
    await assert.rejects(() => assertSafeUrl('http://[64:ff9b::a00:1]/payload'), /private IP/);
  });

  // ── IPv4 missing-range regression guards ──────────────────────────────────

  it('blocks multicast 224.0.0.1', async () => {
    await assert.rejects(() => assertSafeUrl('http://224.0.0.1/payload'), /private IP/);
  });

  it('blocks multicast 239.255.255.255 (end of 224.0.0.0/4)', async () => {
    await assert.rejects(() => assertSafeUrl('http://239.255.255.255/payload'), /private IP/);
  });

  it('blocks reserved 240.0.0.0/4', async () => {
    await assert.rejects(() => assertSafeUrl('http://240.0.0.1/payload'), /private IP/);
  });

  it('blocks broadcast 255.255.255.255', async () => {
    await assert.rejects(() => assertSafeUrl('http://255.255.255.255/payload'), /private IP/);
  });

  it('blocks IETF benchmark 198.18.0.0/15', async () => {
    await assert.rejects(() => assertSafeUrl('http://198.18.0.1/payload'), /private IP/);
  });

  it('blocks docs TEST-NET-1 192.0.2.0/24', async () => {
    await assert.rejects(() => assertSafeUrl('http://192.0.2.50/payload'), /private IP/);
  });

  it('blocks docs TEST-NET-2 198.51.100.0/24', async () => {
    await assert.rejects(() => assertSafeUrl('http://198.51.100.50/payload'), /private IP/);
  });

  it('blocks docs TEST-NET-3 203.0.113.0/24', async () => {
    await assert.rejects(() => assertSafeUrl('http://203.0.113.50/payload'), /private IP/);
  });

  // ── URL validation ─────────────────────────────────────────────────────────

  it('throws on completely invalid URL', async () => {
    await assert.rejects(() => assertSafeUrl('not-a-url'), /Invalid webhook URL/);
  });

  it('throws on non-http(s) protocol', async () => {
    await assert.rejects(
      () => assertSafeUrl('ftp://example.com/file'),
      /Invalid webhook URL protocol|DNS resolution failed|Invalid/,
    );
  });

  it('enforces HTTPS in production', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(() => assertSafeUrl('http://example.com/webhook'), /HTTPS/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('allows HTTP outside production (development)', async () => {
    process.env.NODE_ENV = 'test';
    // Should not throw for HTTPS reason; may throw DNS for example.com
    // We just check it does NOT throw the HTTPS error
    try {
      await assertSafeUrl('http://example.com/webhook');
    } catch (err) {
      assert.ok(
        !err.message.includes('HTTPS'),
        `Should not enforce HTTPS in test env, got: ${err.message}`,
      );
    }
  });
});
