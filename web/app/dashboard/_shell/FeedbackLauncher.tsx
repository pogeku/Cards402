// Floating feedback button — bottom-right of every dashboard page.
// Opens a small popover with a textarea that posts to /api/feedback.

'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useDashboard } from '../_lib/DashboardProvider';
import { useToast } from '../_ui/Toast';
import { Button } from '../_ui/Button';

export function FeedbackLauncher() {
  const { user } = useDashboard();
  const toast = useToast();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, path: pathname, email: user?.email }),
      });
      if (!res.ok) throw new Error('failed');
      setMessage('');
      setOpen(false);
      toast.push('Thanks — feedback sent', 'success');
    } catch {
      toast.push('Failed to send feedback', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Feedback"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          width: 42,
          height: 42,
          borderRadius: '50%',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          color: 'var(--fg)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'var(--shadow-card)',
          zIndex: 40,
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 72,
            right: 20,
            width: 320,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '1rem',
            zIndex: 41,
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <div
            style={{
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--fg)',
              marginBottom: '0.4rem',
            }}
          >
            Send feedback
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-dim)', marginBottom: '0.65rem' }}>
            What's broken, what's missing, what's confusing?
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us anything…"
            rows={4}
            maxLength={2000}
            style={{
              width: '100%',
              padding: '0.6rem 0.75rem',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--fg)',
              fontSize: '0.78rem',
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              marginTop: '0.6rem',
              justifyContent: 'flex-end',
            }}
          >
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={submit} disabled={busy || !message.trim()}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
