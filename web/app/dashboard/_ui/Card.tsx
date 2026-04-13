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
  const isEdgeToEdge = padding === 0 || padding === '0';
  return (
    <div
      className={isEdgeToEdge ? 'dashboard-card dashboard-card-scroll' : 'dashboard-card'}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-card)',
        // Scroll shell for borderless table cards needs overflow-hidden
        // on the wrapper so the fade mask we paint via CSS stays
        // clipped inside the rounded corners.
        overflow: isEdgeToEdge ? 'hidden' : undefined,
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
      <div
        style={{
          padding: typeof padding === 'number' ? `${padding}px` : padding,
          // When the card hosts a borderless table (padding=0) the inner
          // div doubles as a horizontal scroll container so the table
          // can use min-width: 580px on narrow viewports without
          // overflowing the parent. iOS gets momentum scrolling for
          // free via -webkit-overflow-scrolling: touch, which webkit
          // applies automatically when overflow:auto is set.
          overflowX: padding === 0 || padding === '0' ? 'auto' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
