// Placeholder used by routes not yet implemented (analytics, merchants,
// alerts, settings, teams). Keeps the sidebar links alive without the
// user hitting a 404, and signals scope explicitly.

import type { ReactNode } from 'react';
import { Card } from '../_ui/Card';

interface Props {
  title: string;
  description?: ReactNode;
  eta?: string;
}

export function StubPage({ title, description, eta }: Props) {
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
          {title}
        </div>
      </div>
      <Card>
        <div
          style={{
            padding: '2rem 1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: '0.82rem',
              color: 'var(--fg)',
              fontWeight: 500,
            }}
          >
            Coming next
          </div>
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--fg-dim)',
              maxWidth: 420,
              margin: '0 auto',
              lineHeight: 1.5,
            }}
          >
            {description ??
              'This area is planned for a follow-up phase. The dashboard shell is live so we can start shipping features here next.'}
          </div>
          {eta && (
            <div style={{ fontSize: '0.7rem', color: 'var(--fg-dim)', marginTop: '0.25rem' }}>
              ETA: {eta}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
