// Header search with keyboard shortcut and result popover. Phase 1:
// fuzzy match over loaded agents and orders (everything already in
// memory via DashboardProvider). Enter jumps to the highlighted
// result; arrow keys navigate; Esc clears.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboard } from '../_lib/DashboardProvider';
import { truncateAddress } from '../_lib/format';

interface Result {
  type: 'agent' | 'order';
  id: string;
  label: string;
  sub: string;
  href: string;
}

export function GlobalSearch() {
  const { agents, orders } = useDashboard();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);

  // / shortcut focuses the search unless the user is already typing elsewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Result[] = [];
    for (const a of agents) {
      const label = (a.label || 'Unnamed').toLowerCase();
      const addr = (a.wallet_public_key || '').toLowerCase();
      if (label.includes(q) || addr.includes(q) || a.id.toLowerCase().includes(q)) {
        out.push({
          type: 'agent',
          id: a.id,
          label: a.label || 'Unnamed agent',
          sub: truncateAddress(a.wallet_public_key, 6, 4),
          href: `/dashboard/agents/${a.id}`,
        });
      }
      if (out.length >= 10) break;
    }
    for (const o of orders) {
      if (out.length >= 14) break;
      if (
        o.id.toLowerCase().includes(q) ||
        (o.api_key_label || '').toLowerCase().includes(q) ||
        (o.stellar_txid || '').toLowerCase().includes(q)
      ) {
        out.push({
          type: 'order',
          id: o.id,
          label: `Order ${o.id.slice(0, 8)}`,
          sub: `${o.api_key_label || o.api_key_id.slice(0, 8)} · $${o.amount_usdc}`,
          href: `/dashboard/orders?open=${o.id}`,
        });
      }
    }
    return out.slice(0, 14);
  }, [query, agents, orders]);

  // Reset cursor when results change
  useEffect(() => {
    setCursor(0);
  }, [query]);

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('');
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      const r = results[cursor];
      if (r) {
        router.push(r.href);
        setQuery('');
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  }

  return (
    <div style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '0.4rem 0.65rem',
        }}
      >
        <span style={{ color: 'var(--fg-dim)' }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 21l-4.35-4.35M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z" />
          </svg>
        </span>
        <input
          ref={inputRef}
          placeholder="Search agents, orders, txids…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so click events on results register before close
            setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={handleKey}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--fg)',
            fontSize: '0.78rem',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.68rem',
            color: 'var(--fg-dim)',
            padding: '0.1rem 0.35rem',
            border: '1px solid var(--border)',
            borderRadius: 4,
          }}
        >
          /
        </span>
      </div>

      {open && results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-card)',
            padding: '0.25rem',
            maxHeight: 400,
            overflowY: 'auto',
            zIndex: 30,
          }}
        >
          {results.map((r, i) => (
            <button
              key={`${r.type}-${r.id}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                router.push(r.href);
                setQuery('');
                setOpen(false);
              }}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.55rem 0.7rem',
                background: i === cursor ? 'var(--surface-hover)' : 'transparent',
                border: 'none',
                borderRadius: 6,
                color: 'var(--fg)',
                fontSize: '0.78rem',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  fontSize: '0.6rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--fg-dim)',
                  fontFamily: 'var(--font-mono)',
                  width: 46,
                  flexShrink: 0,
                }}
              >
                {r.type}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.label}
                </div>
                <div
                  style={{
                    fontSize: '0.68rem',
                    color: 'var(--fg-dim)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.sub}
                </div>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
