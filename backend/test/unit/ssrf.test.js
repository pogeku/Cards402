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
