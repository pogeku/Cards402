// POST /api/auth/login — server-side proxy for the backend's OTP send step.
// Accepts { email } and forwards to the cards402 backend. Does not touch cookies.

import { NextResponse, type NextRequest } from 'next/server';
import { getBackendBaseUrl } from '@/app/lib/admin-session';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const upstream = await fetch(`${getBackendBaseUrl()}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The backend enforces HTTPS via x-forwarded-proto; our upstream
      // fetch is plain HTTP (localhost:4000), so set it explicitly so
      // the backend sees the request as originating over TLS.
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
