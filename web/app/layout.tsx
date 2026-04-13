import type { Metadata } from 'next';
import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { MarketingChrome } from '@/app/components/MarketingChrome';
import './globals.css';

// Typography system. The marketing + docs surface runs Fraunces for
// display and IBM Plex Sans for body. The dashboard also picks up Plex
// Sans by inheritance and Plex Mono for every place it currently uses
// var(--font-mono) (tables, addresses, api keys, order ids). Avoiding
// Geist / Inter / Space Grotesk on purpose — those are the three fonts
// every AI-generated app ships with, and Cards402 should read as
// engineering-led finance, not yet-another-startup.
const displayFont = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  // Variable weight lets us hit any axis stop from CSS via
  // font-variation-settings. Fraunces's opsz + SOFT axes give the hero
  // display its distinct "pressed into paper" character.
  axes: ['opsz', 'SOFT'],
  style: ['normal', 'italic'],
});

const bodyFont = IBM_Plex_Sans({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
  weight: ['300', '400', '500', '600', '700'],
});

const monoFont = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-mono-next',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Cards402 — Virtual Visa cards for AI agents',
  description:
    'One Stellar transaction in, one real Visa card out. Pay in USDC or XLM, get a PAN in ~60 seconds. No custody, no signup, no KYC.',
  metadataBase: new URL('https://cards402.com'),
  openGraph: {
    title: 'Cards402 — Virtual Visa cards for AI agents',
    description: 'One Stellar transaction in, one real Visa card out. ~60 seconds from pay to PAN.',
    url: 'https://cards402.com',
    siteName: 'Cards402',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cards402 — Virtual Visa cards for AI agents',
    description: 'One Stellar transaction in, one real Visa card out. ~60 seconds from pay to PAN.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}>
      <body
        style={{
          background: 'var(--bg)',
          color: 'var(--fg)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          margin: 0,
          // Typographic hygiene. Chrome in particular happily renders SVG
          // paths with blurry subpixel edges unless you nudge it here, and
          // Plex + Fraunces both benefit from grayscale antialiasing on
          // dark backgrounds.
          textRendering: 'optimizeLegibility',
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        }}
      >
        <MarketingChrome>{children}</MarketingChrome>
      </body>
    </html>
  );
}
