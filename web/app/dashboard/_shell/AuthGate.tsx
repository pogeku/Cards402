// Minimal OTP sign-in splash. Posts { email } to /api/auth/login to
// receive an OTP, then posts { email, code } to /api/auth/verify which
// sets the HttpOnly session cookie and responds with the user object.
// On success we reload — the DashboardProvider picks up the new session.

'use client';

import { useState } from 'react';
import { Button } from '../_ui/Button';
import { Input } from '../_ui/Input';
import { Wordmark } from '@/app/components/Wordmark';

export function AuthGate() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error('failed to send code');
      setStage('code');
    } catch (err) {
      setError((err as Error).message || 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) throw new Error('invalid code');
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '2rem',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <div
          style={{
            marginBottom: '0.5rem',
            color: 'var(--fg)',
          }}
        >
          <Wordmark height={22} />
        </div>
        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--fg-dim)',
            marginBottom: '1.5rem',
          }}
        >
          Sign in to your operator dashboard
        </div>

        {stage === 'email' ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
              <Button
                variant="primary"
                onClick={sendCode}
                disabled={busy || !email}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--fg-dim)' }}>
                Code sent to <strong style={{ color: 'var(--fg)' }}>{email}</strong>
              </div>
              <Input
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
              <Button
                variant="primary"
                onClick={verifyCode}
                disabled={busy || code.length < 6}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {busy ? 'Verifying…' : 'Sign in'}
              </Button>
              <button
                onClick={() => {
                  setStage('email');
                  setCode('');
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--fg-dim)',
                  fontSize: '0.72rem',
                  cursor: 'pointer',
                  marginTop: '0.25rem',
                }}
              >
                ← use different email
              </button>
            </div>
          </>
        )}

        {error && (
          <div
            style={{
              marginTop: '0.85rem',
              fontSize: '0.72rem',
              color: 'var(--red)',
              padding: '0.55rem 0.7rem',
              background: 'var(--red-muted)',
              border: '1px solid var(--red-border)',
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
