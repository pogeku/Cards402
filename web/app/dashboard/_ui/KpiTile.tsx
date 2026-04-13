// Large KPI tile — labeled metric with an optional delta indicator.
// Used in row-of-four patterns on the overview and agent detail pages.

import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  delta?: { value: string; positive?: boolean } | null;
  hint?: ReactNode;
}

export function KpiTile({ label, value, delta, hint }: Props) {
  return (
    <div
      style={{
        flex: 1,
        padding: '1rem 1.25rem',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.5rem',
          fontWeight: 600,
          color: 'var(--fg)',
          fontFamily: 'var(--font-mono)',
          lineHeight: 1.15,
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </div>
      {(delta || hint) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.15rem' }}>
          {delta && (
            <span
              style={{
                fontSize: '0.7rem',
                fontFamily: 'var(--font-mono)',
                color: delta.positive ? 'var(--green)' : 'var(--red)',
              }}
            >
              {delta.positive ? '↑' : '↓'} {delta.value}
            </span>
          )}
          {hint && <span style={{ fontSize: '0.7rem', color: 'var(--fg-dim)' }}>{hint}</span>}
        </div>
      )}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>{children}</div>;
}
