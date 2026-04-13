// Key/value row used in detail drawers and settings cards. Left column
// holds the label (+ optional description); right column holds the
// value or input.

import type { ReactNode } from 'react';

interface Props {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}

export function LabeledRow({ label, description, children }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: description ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: '1rem',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: '0.82rem', color: 'var(--fg)', fontWeight: 500 }}>{label}</div>
        {description && (
          <div
            style={{
              fontSize: '0.7rem',
              color: 'var(--fg-dim)',
              marginTop: '0.2rem',
              lineHeight: 1.45,
              maxWidth: 420,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}
