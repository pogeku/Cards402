// Dynamic Open Graph image for every Cards402 route. Placed at the
// app-root segment so Next.js inherits it down to every page unless a
// child segment provides its own opengraph-image.
//
// Deliberately low-dependency: ImageResponse can't render external
// fonts without us shipping the font binary, so we lean on a
// carefully-weighted system serif stack that matches Fraunces's
// editorial tone closely enough for a 1200x630 social card. No JSX
// children come from data — the card is fixed marketing copy.

import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Cards402 — Virtual Visa cards for AI agents';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OGImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 80px',
        background:
          'radial-gradient(ellipse 60% 55% at 30% 20%, rgba(124, 255, 178, 0.12), transparent 70%), radial-gradient(ellipse 50% 40% at 75% 85%, rgba(124, 255, 178, 0.08), transparent 70%), #050505',
        color: '#f4f4f4',
        fontFamily: '"Georgia", serif',
      }}
    >
      {/* Top row: eyebrow + live pill */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 18,
            letterSpacing: 4,
            textTransform: 'uppercase',
            color: '#7cffb2',
            fontWeight: 600,
            display: 'flex',
          }}
        >
          CARDS402
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 16px',
            border: '1px solid rgba(124, 255, 178, 0.26)',
            background: 'rgba(124, 255, 178, 0.1)',
            borderRadius: 999,
            fontFamily: 'monospace',
            fontSize: 16,
            color: '#7cffb2',
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#7cffb2',
              display: 'flex',
            }}
          />
          Live on Stellar mainnet
        </div>
      </div>

      {/* Display line */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          maxWidth: 1000,
        }}
      >
        <div
          style={{
            fontSize: 92,
            lineHeight: 0.95,
            letterSpacing: -3,
            color: '#f4f4f4',
            fontWeight: 500,
            display: 'flex',
            flexWrap: 'wrap',
          }}
        >
          Virtual Visa cards,
        </div>
        <div
          style={{
            fontSize: 92,
            lineHeight: 0.95,
            letterSpacing: -3,
            color: '#f4f4f4',
            fontWeight: 500,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 24,
          }}
        >
          issued to
          <span
            style={{
              fontStyle: 'italic',
              color: '#7cffb2',
              display: 'flex',
            }}
          >
            agents.
          </span>
        </div>
      </div>

      {/* Bottom row: metrics */}
      <div
        style={{
          display: 'flex',
          gap: 72,
          paddingTop: 36,
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          alignItems: 'flex-end',
        }}
      >
        {[
          { label: 'TIME TO CARD', value: '≈60s' },
          { label: 'NETWORK', value: 'Stellar' },
          { label: 'CUSTODY', value: 'None' },
          { label: 'PRICING', value: 'Face value' },
        ].map((m) => (
          <div
            key={m.label}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 13,
                color: 'rgba(255, 255, 255, 0.44)',
                letterSpacing: 2,
                display: 'flex',
              }}
            >
              {m.label}
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 500,
                color: '#f4f4f4',
                display: 'flex',
              }}
            >
              {m.value}
            </div>
          </div>
        ))}
      </div>
    </div>,
    {
      ...size,
    },
  );
}
