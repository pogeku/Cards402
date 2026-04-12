// /api/admin-proxy/[...path] — forwards admin UI calls to the cards402
// backend with the Bearer token injected server-side. The browser never holds
// the token; it only has an HttpOnly signed cookie that this route verifies.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import {
  ADMIN_SESSION_COOKIE,
  getBackendBaseUrl,
  verifySession,
} from '@/app/lib/admin-session';

export const runtime = 'nodejs';

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
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
  };

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = req.headers.get('content-type');
    if (ct) upstreamHeaders['Content-Type'] = ct;
    body = await req.text();
  }

  const upstream = await fetch(upstreamUrl.toString(), {
    method: req.method,
    headers: upstreamHeaders,
    body,
    signal: AbortSignal.timeout(30000),
  });

  // Preserve Content-Type for non-JSON responses (e.g. CSV exports)
  const ct = upstream.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  }

  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: upstream.status,
    headers: {
      'Content-Type': ct || 'application/octet-stream',
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
