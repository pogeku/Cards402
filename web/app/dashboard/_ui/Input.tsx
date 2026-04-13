// Plain text input. Matches the dark surfaces of the rest of the UI.
// Prefix/suffix slots are optional for currency units, icons, etc.

import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react';

// React's InputHTMLAttributes declares `prefix: string` which would
// collide with our richer prop — Omit it so we can take ReactNode.
interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  prefix?: ReactNode;
  suffix?: ReactNode;
  wrapperStyle?: CSSProperties;
}

export function Input({ prefix, suffix, wrapperStyle, style, ...rest }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '0.45rem 0.7rem',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        color: 'var(--fg)',
        ...wrapperStyle,
      }}
    >
      {prefix && <span style={{ color: 'var(--fg-dim)' }}>{prefix}</span>}
      <input
        {...rest}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'inherit',
          font: 'inherit',
          ...style,
        }}
      />
      {suffix && <span style={{ color: 'var(--fg-dim)' }}>{suffix}</span>}
    </div>
  );
}
