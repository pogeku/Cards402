// Feedback page — full-page form that posts to /api/feedback which
// fires a Discord embed on our ops webhook. The same form is
// available as a floating button via FeedbackLauncher in the shell.

'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Card } from '../_ui/Card';
import { Button } from '../_ui/Button';
import { useDashboard } from '../_lib/DashboardProvider';
import { useToast } from '../_ui/Toast';

export default function FeedbackPage() {
  const { user } = useDashboard();
  const toast = useToast();
  const pathname = usePathname();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          path: pathname,
          email: user?.email,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'failed');
      setSent(true);
      setMessage('');
      toast.push('Thanks — feedback sent', 'success');
    } catch (err) {
      toast.push((err as Error).message || 'failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        padding: '1.5rem 1.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
        maxWidth: 720,
      }}
    >
      <div>
        <div style={{ fontSize: '1.35rem', fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>
          Feedback
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)' }}>
          What's broken, what's confusing, what would you like to see?
        </div>
      </div>

      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us anything. The dashboard team reads every one."
            rows={8}
            maxLength={2000}
            style={{
              width: '100%',
              padding: '0.85rem 1rem',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--fg)',
              fontSize: '0.85rem',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.72rem',
              color: 'var(--fg-dim)',
            }}
          >
            <span>{message.length} / 2000</span>
            <Button variant="primary" onClick={submit} disabled={busy || !message.trim()}>
              {busy ? 'Sending…' : sent ? 'Sent' : 'Send feedback'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
