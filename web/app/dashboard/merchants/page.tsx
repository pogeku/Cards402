// Merchants — card grid of the gift-card products cards402 has
// onboarded. Phase 3 exposes exactly the merchants the backend enables;
// browsing the full upstream catalog is deferred until more merchants
// go live.

'use client';

import { useEffect, useState } from 'react';
import { Card } from '../_ui/Card';
import { Pill } from '../_ui/Pill';
import { PageContainer } from '../_ui/PageContainer';
import { PageHeader } from '../_ui/PageHeader';
import { EmptyState } from '../_ui/EmptyState';
import { fetchMerchants } from '../_lib/api';
import type { EnabledMerchant } from '../_lib/types';
import { formatUsd } from '../_lib/format';

export default function MerchantsPage() {
  const [merchants, setMerchants] = useState<EnabledMerchant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMerchants()
      .then((d) => {
        if (alive) setMerchants(d.merchants);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message || 'failed');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PageContainer>
      <PageHeader
        title="Merchants"
        subtitle="Gift card products Cards402 has onboarded. More are coming — contact support if you need a specific one enabled."
      />

      {error ? (
        <Card>
          <EmptyState title="Couldn't load merchants" description={error} />
        </Card>
      ) : merchants === null ? (
        <Card>
          <EmptyState title="Loading…" description="Fetching the enabled merchant catalog." />
        </Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          {merchants.map((m) => (
            <MerchantCard key={m.id} merchant={m} />
          ))}
          <ComingSoonCard />
        </div>
      )}
    </PageContainer>
  );
}

function MerchantCard({ merchant }: { merchant: EnabledMerchant }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.8rem',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 8,
            background: 'var(--surface-2)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fontSize: '0.85rem',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
        >
          {merchant.name
            .split(/\W+/)
            .map((w) => w[0])
            .slice(0, 2)
            .join('')
            .toUpperCase()}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: '0.85rem',
              fontWeight: 600,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {merchant.name}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--fg-dim)' }}>
            {merchant.country} · {merchant.currency}
          </div>
        </div>
        <Pill tone="green">Enabled</Pill>
      </div>

      <div
        style={{
          fontSize: '0.76rem',
          color: 'var(--fg-dim)',
          lineHeight: 1.5,
          minHeight: 44,
        }}
      >
        {merchant.description}
      </div>

      <div
        style={{
          paddingTop: '0.5rem',
          borderTop: '1px solid var(--border)',
        }}
      >
        <Stat
          label="Range"
          value={`${formatUsd(merchant.min_amount, 0)}–${formatUsd(merchant.max_amount, 0)}`}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: '0.62rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-dim)',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '0.82rem',
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          color: 'var(--fg)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ComingSoonCard() {
  return (
    <div
      style={{
        background: 'transparent',
        border: '1px dashed var(--border-strong)',
        borderRadius: 12,
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.55rem',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        color: 'var(--fg-dim)',
        minHeight: 220,
      }}
    >
      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--fg-muted)' }}>
        More merchants coming
      </div>
      <div style={{ fontSize: '0.72rem', maxWidth: 220, lineHeight: 1.5 }}>
        We&apos;re evaluating which merchants to onboard next. If you need a specific one, send
        feedback — we prioritise based on demand.
      </div>
    </div>
  );
}
