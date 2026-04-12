// No-op middleware.
//
// Both /dashboard and /admin render their own client-side login walls
// (email → OTP → session cookie), so server-side redirects on missing
// session only break the UX — clicking "Sign in" on the marketing page
// would otherwise bounce straight past the dashboard login form to
// /admin's login wall. Real auth is enforced by the backend API and
// the /api/admin-proxy + /api/auth route handlers, which read and
// verify the HMAC-signed cookie themselves.

import { NextResponse } from 'next/server';

export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
