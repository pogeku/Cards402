// POST /api/auth/logout — clears the admin session cookie and notifies the
// backend so it can invalidate the Bearer token server-side.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import {
  ADMIN_SESSION_COOKIE,
  getBackendBaseUrl,
  verifySession,
} from '@/app/lib/admin-session';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest) {
  const cookieStore = await cookies();
  const session = verifySession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);

  if (session) {
    // Best-effort — backend logout failure should not block the client logout
    await fetch(`${getBackendBaseUrl()}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  return res;
}
