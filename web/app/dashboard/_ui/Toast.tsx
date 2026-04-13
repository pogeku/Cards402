// Simple toast context. Provider holds a queue, consumers call push().
// Auto-dismiss after 4s. No queue limit — the UI stacks them.

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

interface Ctx {
  push: (message: string, tone?: Tone) => void;
}

const ToastCtx = createContext<Ctx | null>(null);

export function useToast(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = ++idRef.current;
    setItems((list) => [...list, { id, tone, message }]);
    setTimeout(() => {
      setItems((list) => list.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const value = useMemo<Ctx>(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          zIndex: 100,
          maxWidth: 340,
        }}
      >
        {items.map((t) => (
          <div
            key={t.id}
            style={{
              background: 'var(--surface)',
              border: `1px solid ${
                t.tone === 'success'
                  ? 'var(--green-border)'
                  : t.tone === 'error'
                    ? 'var(--red-border)'
                    : 'var(--border)'
              }`,
              borderRadius: 8,
              padding: '0.7rem 0.85rem',
              fontSize: '0.78rem',
              color: 'var(--fg)',
              boxShadow: 'var(--shadow-card)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.55rem',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background:
                  t.tone === 'success'
                    ? 'var(--green)'
                    : t.tone === 'error'
                      ? 'var(--red)'
                      : 'var(--blue)',
                marginTop: 6,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, lineHeight: 1.45 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
