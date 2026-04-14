'use client';

// Code block with a copy-to-clipboard button in the corner. Used on
// the developer-facing docs pages. Purely decorative if clipboard
// isn't available (old browsers, restrictive permissions policy) —
// the button falls back to selecting the text.

import { useState, type CSSProperties } from 'react';

export function CopyCodeBlock({
  label,
  children,
  maxHeight,
}: {
  label?: string;
  children: string;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API unavailable — select the pre so the user can
      // still ⌘C it manually.
      const sel = window.getSelection();
      const pre = document.getElementById('copy-target-' + Math.random());
      if (sel && pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  const preStyle: CSSProperties = {
    margin: 0,
    fontSize: '0.78rem',
    lineHeight: 1.7,
    overflow: 'auto',
    maxHeight,
  };

  return (
    <div style={{ margin: '0 0 1.35rem' }}>
      {label && (
        <div
          className="type-eyebrow"
          style={{
            fontSize: '0.6rem',
            marginBottom: '0.5rem',
            color: 'var(--fg-dim)',
          }}
        >
          {label}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <pre style={preStyle}>
          <code>{children}</code>
        </pre>
        <button
          onClick={copy}
          aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
          className="copy-code-btn"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            padding: '0.35rem 0.65rem',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.62rem',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            background: copied ? 'var(--green-muted)' : 'var(--surface-hover)',
            border: `1px solid ${copied ? 'var(--green-border)' : 'var(--border)'}`,
            borderRadius: 6,
            color: copied ? 'var(--green)' : 'var(--fg-muted)',
            cursor: 'pointer',
            transition:
              'background 0.2s var(--ease-out), color 0.2s var(--ease-out), border-color 0.2s var(--ease-out)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>

        <style>{`
          .copy-code-btn:hover {
            color: var(--fg);
            border-color: var(--border-strong);
          }
        `}</style>
      </div>
    </div>
  );
}
