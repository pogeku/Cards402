// Colored status pill with a leading dot. Drives agent state badges and
// order status badges. Colors map to the CSS variable palette so both
// themes look right.

import type { ReactNode } from 'react';

export type PillTone = 'green' | 'red' | 'yellow' | 'blue' | 'purple' | 'neutral';

interface Props {
  tone?: PillTone;
  pulse?: boolean;
  children: ReactNode;
  title?: string;
}

const TONE_VARS: Record<PillTone, { fg: string; bg: string; border: string }> = {
  green: { fg: 'var(--green)', bg: 'var(--green-muted)', border: 'var(--green-border)' },
  red: { fg: 'var(--red)', bg: 'var(--red-muted)', border: 'var(--red-border)' },
  yellow: { fg: 'var(--yellow)', bg: 'var(--yellow-muted)', border: 'var(--yellow-border)' },
  blue: { fg: 'var(--blue)', bg: 'var(--blue-muted)', border: 'var(--blue-border)' },
  purple: { fg: 'var(--purple)', bg: 'var(--purple-muted)', border: 'var(--purple-border)' },
  neutral: { fg: 'var(--fg-muted)', bg: 'var(--surface-2)', border: 'var(--border)' },
};

export function Pill({ tone = 'neutral', pulse, children, title }: Props) {
  const c = TONE_VARS[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        fontSize: '0.7rem',
        fontFamily: 'var(--font-mono)',
        color: c.fg,
        padding: '0.2rem 0.55rem',
        borderRadius: 4,
        border: `1px solid ${c.border}`,
        background: c.bg,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'currentColor',
          display: 'inline-block',
          animation: pulse ? 'pulse 2s ease-in-out infinite' : undefined,
        }}
      />
      {children}
    </span>
  );
}
