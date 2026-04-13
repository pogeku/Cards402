// GET /api/auth/me — forwards the current session's Bearer token to the
// backend's /auth/me endpoint. Returns 401 if the cookie is missing,
// tampered, or expired, so the client can drop back to the login screen.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_SESSION_COOKIE, getBackendBaseUrl, verifySession } from '@/app/lib/admin-session';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest) {
  const cookieStore = await cookies();
  const session = verifySession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const upstream = await fetch(`${getBackendBaseUrl()}/auth/me`, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      'X-Forwarded-Proto': 'https',
    },
    signal: AbortSignal.timeout(10000),
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
