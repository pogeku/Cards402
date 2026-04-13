// Title + subtitle + action slot for the top of every page. Having a
// single component means padding, font-size, and spacing stay aligned
// across Overview / Agents / Orders / Settings / etc.

import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        {breadcrumb && (
          <div
            style={{
              fontSize: '0.72rem',
              color: 'var(--fg-dim)',
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            {breadcrumb}
          </div>
        )}
        <div
          style={{
            fontSize: '1.35rem',
            fontWeight: 600,
            color: 'var(--fg)',
            marginBottom: 4,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </div>
        {subtitle && <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)' }}>{subtitle}</div>}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>{actions}</div>
      )}
    </div>
  );
}
