// Labeled toggle switch with optional description and inline input.
// Matches the Ampersand "setting row" pattern where a toggle, label,
// description and value field sit on one horizontal rhythm.

import type { ReactNode } from 'react';

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode; // inline value, e.g. an Input
}

export function Toggle({ checked, onChange, label, description, children }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.85rem',
        padding: '0.85rem 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <button
        onClick={() => onChange(!checked)}
        style={{
          marginTop: 2,
          width: 30,
          height: 16,
          borderRadius: 16,
          border: `1px solid ${checked ? 'var(--green-border)' : 'var(--border)'}`,
          background: checked ? 'var(--green-dim)' : 'var(--surface-2)',
          position: 'relative',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'background 120ms, border-color 120ms',
        }}
        aria-pressed={checked}
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: checked ? 15 : 1,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: checked ? 'var(--bg)' : 'var(--fg-dim)',
            transition: 'left 140ms',
          }}
        />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.78rem',
            fontWeight: 500,
            color: 'var(--fg)',
            lineHeight: 1.4,
          }}
        >
          {label}
        </div>
        {description && (
          <div
            style={{
              fontSize: '0.7rem',
              color: 'var(--fg-dim)',
              marginTop: '0.2rem',
              lineHeight: 1.45,
            }}
          >
            {description}
          </div>
        )}
        {children && <div style={{ marginTop: '0.5rem' }}>{children}</div>}
      </div>
    </div>
  );
}
