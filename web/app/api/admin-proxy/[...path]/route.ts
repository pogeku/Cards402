// /api/admin-proxy/[...path] — forwards admin UI calls to the cards402
// backend with the Bearer token injected server-side. The browser never holds
// the token; it only has an HttpOnly signed cookie that this route verifies.
//
// Three response shapes are handled distinctly:
//
//   1. text/event-stream — long-lived SSE streams (/dashboard/stream, etc).
//      We pipe upstream.body straight through as a ReadableStream and do
//      NOT set an AbortSignal timeout — SSE connections are expected to
//      stay open until the client disconnects. Buffering them with
//      arrayBuffer() (or aborting with a 30s timeout) was causing 500
//      errors and silently breaking live dashboard updates.
//
//   2. application/json — read the body, re-serialise, return with status.
//      Keeps error messages intact for downstream error surfaces.
//
//   3. everything else (binary, CSV, etc) — buffer into an arrayBuffer,
//      preserve content-type + content-disposition headers for downloads.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_SESSION_COOKIE, getBackendBaseUrl, verifySession } from '@/app/lib/admin-session';

export const runtime = 'nodejs';

// Non-stream upstream calls get a 30s cap so we don't leak timers on a
// wedged backend. Streams (SSE) opt out entirely; the client's own
// AbortController is the only thing that ends them.
const NON_STREAM_TIMEOUT_MS = 30_000;

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const cookieStore = await cookies();
  const session = verifySession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { path } = await params;
  const upstreamPath = path.join('/');
  const upstreamUrl = new URL(`${getBackendBaseUrl()}/${upstreamPath}`);

  req.nextUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
    'X-Forwarded-Proto': 'https',
  };

  // Detect an SSE request up-front — either the caller set the Accept
  // header to text/event-stream, or the path matches a known stream
  // endpoint. Either way, pass Accept through so the backend picks the
  // streaming code path.
  const acceptHeader = req.headers.get('accept') ?? '';
  const isEventStreamRequest =
    acceptHeader.includes('text/event-stream') ||
    upstreamPath.endsWith('/stream') ||
    upstreamPath.includes('/stream?');
  if (isEventStreamRequest) {
    upstreamHeaders.Accept = 'text/event-stream';
  }

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = req.headers.get('content-type');
    if (ct) upstreamHeaders['Content-Type'] = ct;
    body = await req.text();
  }

  // Wire the client's own AbortSignal through so if the browser
  // disconnects the SSE stream, we tear down the upstream fetch too.
  // Non-stream requests get an additional wall-clock cap.
  const clientSignal = req.signal;
  let signal: AbortSignal = clientSignal;
  if (!isEventStreamRequest) {
    signal = AbortSignal.any([clientSignal, AbortSignal.timeout(NON_STREAM_TIMEOUT_MS)]);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      body,
      signal,
      // Disable Next.js fetch caching for every admin proxy call —
      // these are inherently per-user and stream.
      cache: 'no-store',
    });
  } catch (err) {
    // Client abort during connection setup is expected on SSE reconnects;
    // return a 499-style code rather than a 500 so the browser doesn't
    // log a scary error.
    if ((err as { name?: string }).name === 'AbortError') {
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json(
      { error: 'upstream_fetch_failed', message: (err as Error).message },
      { status: 502 },
    );
  }

  const upstreamCt = upstream.headers.get('content-type') ?? '';

  // ── 1. Event stream (SSE) ──────────────────────────────────────────────
  if (upstreamCt.includes('text/event-stream')) {
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // ── 2. JSON ────────────────────────────────────────────────────────────
  if (upstreamCt.includes('application/json')) {
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  }

  // ── 3. Anything else (CSV exports, binary, etc) ────────────────────────
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: upstream.status,
    headers: {
      'Content-Type': upstreamCt || 'application/octet-stream',
      ...(upstream.headers.get('content-disposition')
        ? { 'Content-Disposition': upstream.headers.get('content-disposition')! }
        : {}),
    },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
