// Horizontal bar chart — used by analytics for spend-by-agent and the
// error breakdown. Pure SVG so it inherits the theme.

import type { ReactNode } from 'react';

interface Row {
  label: ReactNode;
  value: number;
  trailing?: ReactNode;
}

interface Props {
  rows: Row[];
  max?: number;
  height?: number;
}

export function HorizontalBar({ rows, max, height = 14 }: Props) {
  const maxValue = max ?? Math.max(...rows.map((r) => r.value), 1);
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: '1.25rem 0',
          textAlign: 'center',
          fontSize: '0.75rem',
          color: 'var(--fg-dim)',
        }}
      >
        No data
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
      {rows.map((r, i) => {
        const width = maxValue > 0 ? (r.value / maxValue) * 100 : 0;
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '0.74rem',
                color: 'var(--fg)',
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '60%',
                }}
              >
                {r.label}
              </span>
              <span
                style={{
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                }}
              >
                {r.trailing}
              </span>
            </div>
            <div
              style={{
                height,
                background: 'var(--surface-2)',
                borderRadius: height / 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${width}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, var(--green) 0%, var(--green-dim) 100%)',
                  transition: 'width 240ms',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
