// POST /api/feedback — forwards operator feedback to the Discord webhook
// configured on the backend (DISCORD_WEBHOOK_OPS). We don't want the
// webhook URL exposed to the browser, so the route handler reads it
// from server-only env.
//
// Auth: only allow signed-in operators (verified via the same session
// cookie as the admin proxy). Anonymous feedback would be spam bait.

import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_SESSION_COOKIE, verifySession } from '@/app/lib/admin-session';

export const runtime = 'nodejs';

interface FeedbackBody {
  message: string;
  path?: string;
  email?: string;
}

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = verifySession(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_OPS;
  if (!webhookUrl) {
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
  }

  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const message = (body.message || '').trim();
  if (!message) {
    return NextResponse.json({ error: 'message_required' }, { status: 400 });
  }
  if (message.length > 2000) {
    return NextResponse.json({ error: 'message_too_long' }, { status: 400 });
  }

  const embed = {
    title: '💬 Dashboard feedback',
    description: message,
    color: 0x60a5fa,
    fields: [
      { name: 'Path', value: body.path || '—', inline: true },
      { name: 'From', value: body.email || '—', inline: true },
    ],
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(8000),
  }).catch((err) => {
    return new Response(String(err), { status: 500 });
  });

  if (!res.ok) {
    return NextResponse.json({ error: 'discord_post_failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
