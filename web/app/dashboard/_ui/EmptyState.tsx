// Empty state block — shown when a table or chart has no data. Optional
// CTA button slot.

import type { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  cta?: ReactNode;
}

export function EmptyState({ icon, title, description, cta }: Props) {
  return (
    <div
      style={{
        padding: '3rem 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: '0.75rem',
      }}
    >
      {icon && <div style={{ color: 'var(--fg-dim)', opacity: 0.6 }}>{icon}</div>}
      <div style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--fg)' }}>{title}</div>
      {description && (
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--fg-dim)',
            maxWidth: 360,
            lineHeight: 1.5,
          }}
        >
          {description}
        </div>
      )}
      {cta && <div style={{ marginTop: '0.25rem' }}>{cta}</div>}
    </div>
  );
}
