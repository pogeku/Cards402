// Hero constellation — a slow, deliberate line-drawing of a Stellar
// network graph that resolves into a virtual card silhouette in the
// middle. Pure SVG + CSS animation; no JS after mount, no canvas.
//
// How it works:
//   1. A ring of 12 nodes orbits a central card node.
//   2. Every edge is a path with a huge stroke-dasharray and full
//      stroke-dashoffset on mount. A keyframed `draw-stroke` animation
//      collapses the offset to 0 over ~2.5s, so each edge appears to
//      draw from the center outward.
//   3. Staggered `animation-delay` on each edge creates a ripple effect
//      — the visible pattern is the drawing, not the finished graph.
//   4. A card-shaped rect in the center fades in last and slowly
//      rotates back to horizontal on a `float-card` loop.
//
// Sized to fill its container via viewBox; the parent sets dimensions.
// Works down to ~320px before the outer nodes clip; the parent should
// hide it below iphone-SE-ish widths with a media query.

import type { CSSProperties } from 'react';

const RING_NODES = 12;
const RING_RADIUS = 190;
const CENTER = { x: 300, y: 220 };

// Deterministic angles so the ring reads as a stable constellation
// rather than random noise. 12 evenly-spaced around, offset by -pi/2
// so the top node sits at 12 o'clock.
function ringNode(i: number) {
  const a = (i / RING_NODES) * Math.PI * 2 - Math.PI / 2;
  return {
    x: CENTER.x + Math.cos(a) * RING_RADIUS,
    y: CENTER.y + Math.sin(a) * RING_RADIUS,
  };
}

interface Props {
  style?: CSSProperties;
}

export function HeroConstellation({ style }: Props) {
  const nodes = Array.from({ length: RING_NODES }, (_, i) => ringNode(i));

  return (
    <svg
      viewBox="0 0 600 440"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{
        width: '100%',
        height: '100%',
        overflow: 'visible',
        pointerEvents: 'none',
        ...style,
      }}
    >
      <defs>
        <radialGradient id="cg-center-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.45" />
          <stop offset="70%" stopColor="var(--green)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cg-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.14)" />
          <stop offset="50%" stopColor="rgba(255,255,255,0.05)" />
          <stop offset="100%" stopColor="rgba(124,255,178,0.1)" />
        </linearGradient>
        <linearGradient id="cg-card-shine" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="50%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
        <filter id="cg-blur">
          <feGaussianBlur stdDeviation="30" />
        </filter>
      </defs>

      {/* Background glow disc — soft green pool behind the graph */}
      <circle
        cx={CENTER.x}
        cy={CENTER.y}
        r={RING_RADIUS + 60}
        fill="url(#cg-center-glow)"
        filter="url(#cg-blur)"
      />

      {/* Spokes — each edge draws from the center out on its own delay.
          stroke-dasharray set to a length that comfortably exceeds the
          longest line so the dash pattern always covers the path. */}
      <g stroke="currentColor" fill="none" style={{ opacity: 0.72 }}>
        {nodes.map((n, i) => (
          <line
            key={`edge-${i}`}
            x1={CENTER.x}
            y1={CENTER.y}
            x2={n.x}
            y2={n.y}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray="260"
            strokeDashoffset="260"
            style={{
              animation: `draw-stroke 1.8s var(--ease-out) forwards`,
              animationDelay: `${0.25 + i * 0.07}s`,
            }}
          />
        ))}
      </g>

      {/* Outer ring arcs connecting neighbouring nodes — gives the
          constellation structure without overwhelming it. */}
      <g stroke="currentColor" fill="none" style={{ opacity: 0.42 }}>
        {nodes.map((n, i) => {
          const next = nodes[(i + 1) % RING_NODES];
          if (!next) return null;
          return (
            <line
              key={`arc-${i}`}
              x1={n.x}
              y1={n.y}
              x2={next.x}
              y2={next.y}
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeDasharray="130"
              strokeDashoffset="130"
              style={{
                animation: `draw-stroke 2s var(--ease-out) forwards`,
                animationDelay: `${1.1 + i * 0.04}s`,
              }}
            />
          );
        })}
      </g>

      {/* Ring nodes — dots that fade in as each edge arrives */}
      <g fill="currentColor">
        {nodes.map((n, i) => (
          <g
            key={`node-${i}`}
            style={{
              opacity: 0,
              animation: 'fadeIn 0.5s var(--ease-out) forwards',
              animationDelay: `${0.6 + i * 0.07}s`,
            }}
          >
            {/* Outer halo so each node reads at a glance */}
            <circle cx={n.x} cy={n.y} r={7} fill="currentColor" fillOpacity="0.08" />
            <circle cx={n.x} cy={n.y} r={3.2} fill="currentColor" fillOpacity="0.92" />
          </g>
        ))}
      </g>

      {/* Central card silhouette — fades in last, then breathes on a
          slow loop so the hero has ambient motion even after the
          intro animation settles. */}
      <g
        style={{
          transformOrigin: `${CENTER.x}px ${CENTER.y}px`,
          transform: 'rotate(-4deg)',
          opacity: 0,
          animation:
            'fadeIn 0.9s var(--ease-out) forwards 1.8s, float-card 6.5s ease-in-out infinite 3s',
        }}
      >
        {/* Card body — deeper background to separate from the glow */}
        <rect
          x={CENTER.x - 95}
          y={CENTER.y - 60}
          width={190}
          height={120}
          rx={14}
          fill="#0b0b0b"
          stroke="currentColor"
          strokeOpacity="0.85"
          strokeWidth="1.4"
        />
        <rect
          x={CENTER.x - 95}
          y={CENTER.y - 60}
          width={190}
          height={120}
          rx={14}
          fill="url(#cg-card)"
        />
        {/* Shine stripe */}
        <rect
          x={CENTER.x - 95}
          y={CENTER.y - 60}
          width={190}
          height={120}
          rx={14}
          fill="url(#cg-card-shine)"
          style={{ mixBlendMode: 'overlay' }}
        />
        {/* Card chip */}
        <rect
          x={CENTER.x - 74}
          y={CENTER.y - 32}
          width={30}
          height={22}
          rx={3}
          fill="currentColor"
          fillOpacity="0.55"
        />
        <line
          x1={CENTER.x - 64}
          y1={CENTER.y - 32}
          x2={CENTER.x - 64}
          y2={CENTER.y - 10}
          stroke="#0b0b0b"
          strokeWidth="0.6"
        />
        <line
          x1={CENTER.x - 54}
          y1={CENTER.y - 32}
          x2={CENTER.x - 54}
          y2={CENTER.y - 10}
          stroke="#0b0b0b"
          strokeWidth="0.6"
        />
        {/* Card number strips */}
        <rect
          x={CENTER.x - 74}
          y={CENTER.y + 10}
          width={130}
          height={3.5}
          rx={1}
          fill="currentColor"
          fillOpacity="0.55"
        />
        <rect
          x={CENTER.x - 74}
          y={CENTER.y + 22}
          width={75}
          height={3}
          rx={1}
          fill="currentColor"
          fillOpacity="0.32"
        />
        <rect
          x={CENTER.x - 74}
          y={CENTER.y + 32}
          width={55}
          height={3}
          rx={1}
          fill="currentColor"
          fillOpacity="0.22"
        />
        {/* Cards402 brand dot in the corner */}
        <circle
          cx={CENTER.x + 74}
          cy={CENTER.y - 40}
          r={5}
          fill="var(--green)"
          style={{
            filter: 'drop-shadow(0 0 8px var(--green-glow))',
          }}
        />
      </g>

      {/* Central node pulse — green dot at the origin of every edge */}
      <circle
        cx={CENTER.x}
        cy={CENTER.y}
        r={4}
        fill="var(--green)"
        style={{
          filter: 'drop-shadow(0 0 14px var(--green-glow))',
          opacity: 0,
          animation: 'fadeIn 0.5s ease forwards 0.1s, breathe 4s ease-in-out infinite 2s',
        }}
      />
    </svg>
  );
}
