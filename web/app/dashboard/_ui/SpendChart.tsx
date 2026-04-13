// Minimal SVG area chart. No external chart library — we own the
// render so themes + density stay consistent. Takes bucketed data
// (one point per day) and draws a smoothed area + x-axis day labels.

'use client';

import { useMemo } from 'react';
import { formatUsd } from '../_lib/format';

interface Bucket {
  date: string;
  amount: number;
  count: number;
}

interface Props {
  data: Bucket[];
  height?: number;
}

export function SpendChart({ data, height = 200 }: Props) {
  const { path, areaPath, max, points } = useMemo(() => {
    if (data.length === 0) {
      return {
        path: '',
        areaPath: '',
        max: 0,
        points: [] as Array<{ x: number; y: number; b: Bucket }>,
      };
    }
    const max = Math.max(...data.map((d) => d.amount), 0.01);
    const w = 1000;
    const h = 100;
    const step = data.length > 1 ? w / (data.length - 1) : 0;
    const points = data.map((b, i) => ({
      x: i * step,
      y: h - (b.amount / max) * h,
      b,
    }));
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const last = points[points.length - 1]!;
    const areaPath = `${path} L${last.x},${h} L0,${h} Z`;
    return { path, areaPath, max, points };
  }, [data]);

  if (data.length === 0 || max === 0) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--fg-dim)',
          fontSize: '0.78rem',
        }}
      >
        No spend data for this period
      </div>
    );
  }

  // Pick ~6 evenly-spaced labels so long ranges stay readable
  const labelStride = Math.max(1, Math.floor(data.length / 6));

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <svg
        viewBox={`0 0 1000 120`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
      >
        <defs>
          <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* horizontal gridlines */}
        {[0, 25, 50, 75, 100].map((y) => (
          <line
            key={y}
            x1={0}
            x2={1000}
            y1={y}
            y2={y}
            stroke="var(--border)"
            strokeDasharray="2 4"
            strokeWidth={0.5}
          />
        ))}
        <path d={areaPath} fill="url(#spendFill)" />
        <path d={path} stroke="var(--green)" strokeWidth={1.5} fill="none" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={2}
            fill="var(--green)"
            opacity={p.b.amount > 0 ? 1 : 0}
          />
        ))}
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.65rem',
          color: 'var(--fg-dim)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {data.map((b, i) =>
          i % labelStride === 0 ? (
            <span key={b.date}>{b.date.slice(5)}</span>
          ) : (
            <span key={b.date} />
          ),
        )}
      </div>
      <div style={{ fontSize: '0.68rem', color: 'var(--fg-dim)' }}>Peak: {formatUsd(max)}</div>
    </div>
  );
}
