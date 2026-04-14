// Proxy layer:
//
//   1. No-op for dashboard/admin routes — both render client-side
//      login walls (email → OTP → session cookie). Server-side
//      redirects on missing session break the UX; clicking "Sign
//      in" on the marketing page would bounce past the dashboard
//      login form to /admin's login wall. Real auth is enforced
//      by the backend API and the /api/admin-proxy + /api/auth
//      route handlers, which read and verify the HMAC-signed
//      cookie themselves.
//
//   2. status.cards402.com subdomain — everything under this host
//      rewrites to /status so the subdomain is a dedicated health
//      page regardless of path. Static assets (_next, api) pass
//      through normally so the rewritten /status page can still
//      load its CSS and JS.
//
// File is named `proxy.ts` per the Next.js 16 convention — the old
// `middleware.ts` name is deprecated (the dev server logged a
// migration notice on every startup under the old name). Same
// runtime, same semantics, new filename and function export.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const STATUS_HOST = 'status.cards402.com';

// Match /logo.svg, /icon.png, /skill.md, /robots.txt, /sitemap.xml,
// /humans.txt, /manifest.webmanifest, /.well-known/*, etc. Anything
// with a dot in the last path segment is a static file that should
// pass through unchanged; rewriting /logo.svg to /status would return
// the status page HTML with Content-Type text/html, which the browser
// can't use as a CSS mask-image → the wordmark disappears.
const STATIC_FILE_RE = /\.[a-zA-Z0-9]+$/;

export function proxy(request: NextRequest) {
  // Host-based routing for the status subdomain. Next's matcher can
  // filter on host via `has: [{ type: 'host' }]`, but we double-check
  // here so local dev (where matcher-host conditions don't always
  // fire correctly behind Turbopack) still behaves.
  const host = request.headers.get('host') || '';
  if (host === STATUS_HOST || host.startsWith(`${STATUS_HOST}:`)) {
    const url = request.nextUrl.clone();
    const path = url.pathname;
    // Pass through:
    //   - Next asset pipeline (/_next/*)
    //   - API routes (/api/*)
    //   - Well-known endpoints (/.well-known/security.txt etc.)
    //   - Any path whose last segment has a file extension (static
    //     assets from /public — logo.svg, icon.png, skill.md, ...)
    // Everything else rewrites to /status so the subdomain is a
    // dedicated health page regardless of path.
    if (
      path.startsWith('/_next') ||
      path.startsWith('/api') ||
      path.startsWith('/.well-known') ||
      STATIC_FILE_RE.test(path)
    ) {
      return NextResponse.next();
    }
    url.pathname = '/status';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  // Match everything under status.cards402.com except the Next.js
  // asset pipeline. The main apex host (cards402.com) hits the
  // proxy only via this matcher's `has: host` condition falling
  // through to NextResponse.next() — the cost of one JS call per
  // request on the subdomain, and nothing on the apex. Dev mode
  // falls back to the explicit host check in proxy() above because
  // Turbopack doesn't always honour host-based matchers.
  matcher: [
    {
      // NB: matcher values must be literal strings — Next 16 statically
      // analyses the config at build time and can't follow variable refs.
      // If STATUS_HOST above changes, update this literal too.
      //
      // The negative lookahead excludes:
      //   _next                  → Next asset pipeline
      //   api                    → API routes
      //   \.well-known           → security.txt, etc.
      //   .*\.[a-zA-Z0-9]+$      → any path ending in a file extension,
      //                            which in Next's flat /public layout
      //                            catches logo.svg / icon.png / skill.md
      //                            / robots.txt / humans.txt / sitemap.xml
      //                            / manifest.webmanifest / favicon.ico
      // Everything else passes through to the proxy() function above.
      source: '/((?!_next|api|\\.well-known|.*\\.[a-zA-Z0-9]+$).*)',
      has: [{ type: 'header', key: 'host', value: 'status.cards402.com' }],
    },
  ],
};
