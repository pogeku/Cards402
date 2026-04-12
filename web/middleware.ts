// Admin session middleware.
//
// Protects /dashboard and the state-changing admin routes by verifying the
// HMAC signature of the HttpOnly cards402_admin_session cookie. The admin
// landing page itself (/admin) is allowed through because it renders its own
// login wall — redirecting away from it would break the login UX.
//
// Runs in the Node runtime because verifySession uses Node's crypto module
// (Web Crypto AES/HMAC primitives in the Edge runtime would require a
// separate implementation). Next.js 15 supports this via the runtime export.

import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, verifySession } from '@/app/lib/admin-session';

export const runtime = 'nodejs';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const needsSession = pathname === '/dashboard' || pathname.startsWith('/dashboard/');

  if (!needsSession) return NextResponse.next();

  const cookieValue = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  const session = verifySession(cookieValue);

  if (!session) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/admin';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
