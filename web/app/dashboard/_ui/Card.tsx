// Card — a surface-elevated container. Used for KPI tiles, chart frames,
// table wrappers, side pane sections. Padding optional so tables can go
// edge-to-edge inside a card.

import type { CSSProperties, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  padding?: string | number;
  style?: CSSProperties;
  title?: ReactNode;
  actions?: ReactNode;
}

export function Card({ children, padding = '1rem 1.25rem', style, title, actions }: Props) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-card)',
        ...style,
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.85rem 1.25rem',
            borderBottom: '1px solid var(--border)',
            minHeight: 44,
          }}
        >
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--fg-muted)',
            }}
          >
            {title}
          </div>
          {actions}
        </div>
      )}
      <div style={{ padding: typeof padding === 'number' ? `${padding}px` : padding }}>
        {children}
      </div>
    </div>
  );
}
