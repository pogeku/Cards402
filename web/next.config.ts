import type { NextConfig } from 'next';
import path from 'path';

// Security headers. We set these via next.config rather than a proxy/
// edge function so they're present on static assets, ISR responses,
// and dynamic SSR pages without a second middleware roundtrip.
//
// Content-Security-Policy notes: we deliberately stop short of a full
// `script-src` lockdown. Next.js 16 injects inline `__NEXT_DATA__`
// bootstrapping scripts, so a strict script-src would require nonce
// wiring in middleware — worth doing eventually, but risky to bundle
// with a header-hardening pass. Until then we cover the attack
// vectors that DON'T need to know about scripts:
//   - frame-ancestors 'none'  blocks clickjacking and replaces the
//                             X-Frame-Options line below for modern
//                             browsers (kept for IE-compat legacy).
//   - base-uri 'self'         stops a dangling XSS from relocating
//                             the document base URL to an attacker
//                             host and hijacking relative fetches.
//   - form-action 'self'      forms can't POST to attacker origins
//                             even if an attacker injects one.
//   - object-src 'none'       Flash / plugin vector off.
const CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// HSTS: two years + includeSubDomains + preload. Preload requires
// a minimum 1-year max-age and the exact preload directive; once
// the domain is accepted onto the Chrome preload list, browsers
// refuse plaintext HTTP even on first visit.
const HSTS = 'max-age=63072000; includeSubDomains; preload';

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: HSTS },
          // CSP blocks eval(), which Turbopack needs for HMR in dev.
          // Only enforce in production.
          ...(isDev ? [] : [{ key: 'Content-Security-Policy', value: CSP }]),
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
    ];
  },
};

export default nextConfig;
