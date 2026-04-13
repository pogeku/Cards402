// Pill-shaped filter chip used in headers of list/table pages. Optional
// tone shows a colored dot on the left; `count` lives on the right in
// mono so totals line up.

import type { ReactNode } from 'react';
import type { PillTone } from './Pill';

interface Props {
  active: boolean;
  onClick: () => void;
  count?: number;
  tone?: PillTone;
  children: ReactNode;
}

const TONE_COLOR: Record<PillTone, string> = {
  green: 'var(--green)',
  red: 'var(--red)',
  yellow: 'var(--yellow)',
  blue: 'var(--blue)',
  purple: 'var(--purple)',
  neutral: 'var(--fg-dim)',
};

export function FilterChip({ active, onClick, count, tone, children }: Props) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.45rem',
        padding: '0.35rem 0.7rem',
        background: active ? 'var(--surface)' : 'transparent',
        border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`,
        borderRadius: 999,
        fontSize: '0.72rem',
        lineHeight: 1,
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        cursor: 'pointer',
        fontWeight: active ? 600 : 500,
        whiteSpace: 'nowrap',
      }}
    >
      {tone && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: TONE_COLOR[tone],
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1 }}>
        {children}
      </span>
      {count !== undefined && (
        <span
          style={{
            color: 'var(--fg-dim)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.66rem',
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            paddingLeft: '0.05rem',
            // Mono digits sit ~1px above their baseline relative to the
            // sans label — nudge them down so the chip reads as one row.
            transform: 'translateY(0.5px)',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
