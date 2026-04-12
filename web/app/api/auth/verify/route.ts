// POST /api/auth/verify — exchanges an OTP code for a signed HttpOnly cookie.
// On success the backend returns a Bearer token and a user object. The token
// is wrapped in an HMAC-signed session cookie and never exposed to the
// browser; only the user object is returned to the client.

import { NextResponse, type NextRequest } from 'next/server';
import {
  ADMIN_SESSION_COOKIE,
  SESSION_TTL_MS,
  getBackendBaseUrl,
  signSession,
} from '@/app/lib/admin-session';

export const runtime = 'nodejs';

interface BackendVerifyResponse {
  token?: string;
  user?: unknown;
  error?: string;
  message?: string;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const upstream = await fetch(`${getBackendBaseUrl()}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data: BackendVerifyResponse = await upstream.json().catch(() => ({}));

  if (!upstream.ok || !data.token) {
    return NextResponse.json(
      { error: data.error ?? 'verify_failed', message: data.message },
      { status: upstream.status || 401 },
    );
  }

  const cookieValue = signSession(data.token);
  const res = NextResponse.json({ user: data.user });
  res.cookies.set(ADMIN_SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  });
  return res;
}
