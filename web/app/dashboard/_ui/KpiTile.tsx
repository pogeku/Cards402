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
      className="kpi-tile"
      style={{
        padding: '1rem 1.1rem',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        minWidth: 0,
        // Subtle hover lift — fits the financial surface without
        // being noisy. Pairs with the .kpi-tile global rule in
        // globals.css for the green border + glow.
        transition:
          'transform 0.4s var(--ease-out), border-color 0.4s var(--ease-out), box-shadow 0.4s var(--ease-out)',
      }}
    >
      <div
        style={{
          fontSize: '0.66rem',
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 500,
          fontFamily: 'var(--font-mono)',
          // Ensure the label can wrap on very narrow tiles instead of
          // forcing horizontal overflow.
          wordBreak: 'break-word',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 'clamp(1.25rem, 2.6vw + 0.5rem, 1.65rem)',
          fontWeight: 500,
          color: 'var(--fg)',
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.1,
          letterSpacing: '-0.015em',
          // Long numbers + units (e.g. "$225.00") shouldn't break mid-
          // string. nowrap + a min-width:0 parent lets the tile stay
          // small without truncating the value.
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
      {(delta || hint) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.15rem' }}>
          {delta && (
            <span
              style={{
                fontSize: '0.68rem',
                fontFamily: 'var(--font-mono)',
                color: delta.positive ? 'var(--green)' : 'var(--red)',
              }}
            >
              {delta.positive ? '↑' : '↓'} {delta.value}
            </span>
          )}
          {hint && (
            <span
              style={{
                fontSize: '0.68rem',
                color: 'var(--fg-dim)',
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {hint}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        // CSS Grid auto-fit so tiles wrap to a new row instead of
        // crunching shoulder-to-shoulder. minmax(155px, 1fr) means
        // each tile gets at least 155px before wrapping — at 375px
        // viewport that's 2 tiles per row, at 700px ~3-4, at 1100+ 5.
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))',
        gap: '0.75rem',
      }}
    >
      {children}
    </div>
  );
}
