import type { Metadata, Viewport } from 'next';
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

const SITE_URL = 'https://cards402.com';
const SITE_NAME = 'Cards402';
// Kept under Google's 160-char SERP truncation limit so the whole
// description renders without a trailing ellipsis.
const SITE_DESCRIPTION =
  'Virtual Visa cards for AI agents. Pay with USDC or XLM on Stellar and get a real card in ~60 seconds. Non-custodial, no signup, no KYC.';

export const metadata: Metadata = {
  // Default title that's used unless a page overrides it. The
  // `template` turns per-page titles like "Pricing" into
  // "Pricing — Cards402" so every tab has the brand without each
  // page having to remember.
  title: {
    default: `${SITE_NAME} — Virtual Visa cards for AI agents`,
    template: `%s — ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  generator: 'Next.js',
  metadataBase: new URL(SITE_URL),
  alternates: {
    canonical: SITE_URL,
    // Declaring en-GB as the primary locale and x-default for anyone
    // landing from a non-English search. Once we actually translate
    // pages this block is where the real locale URLs go.
    languages: {
      'en-GB': SITE_URL,
      'x-default': SITE_URL,
    },
  },
  // Keywords meta intentionally omitted — Google has ignored it since
  // ~2009 and it becomes a footgun once pages drift from the list.
  authors: [{ name: 'Cards402', url: SITE_URL }],
  creator: 'Cards402',
  publisher: 'Cards402',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'en_GB',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} — Virtual Visa cards for AI agents`,
    description:
      'One Stellar transaction in, one real Visa card out. ~60 seconds from pay to PAN. No custody, no signup.',
    // og:image comes from app/opengraph-image.tsx (file convention).
    // Don't set it here or child pages that override openGraph lose
    // the image reference.
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — Virtual Visa cards for AI agents`,
    description: 'One Stellar transaction in, one real Visa card out. ~60 seconds from pay to PAN.',
    site: '@cards402',
    creator: '@cards402',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  // Search-engine verification tokens. Drop real values when the
  // corresponding properties are registered in Google Search Console
  // / Bing Webmaster Tools / Yandex etc. Empty strings are omitted
  // by Next.js so leaving them undefined here is fine.
  verification: {
    // google: 'paste Search Console HTML-tag token',
    // yandex: 'paste Yandex Webmaster token',
    // other: { 'msvalidate.01': 'paste Bing Webmaster token' },
  },
  category: 'technology',
};

export const viewport: Viewport = {
  themeColor: '#050505',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

// Organisation / website JSON-LD emitted once on every page. Google +
// Bing use this to render rich results in SERPs (logo, site search,
// social profiles). We intentionally keep this simple — richer types
// (Product, FAQPage, BreadcrumbList) live on the pages that need them.
const jsonLdOrg = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE_URL}#organization`,
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon.png`,
  description: SITE_DESCRIPTION,
  sameAs: ['https://x.com/cards402', 'https://github.com/CTX-com/Cards402'],
  contactPoint: [
    {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: 'support@cards402.com',
      availableLanguage: ['English'],
    },
    {
      '@type': 'ContactPoint',
      contactType: 'press',
      email: 'press@cards402.com',
    },
    {
      '@type': 'ContactPoint',
      contactType: 'security',
      email: 'security@cards402.com',
    },
  ],
};

const jsonLdSite = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  '@id': `${SITE_URL}#website`,
  url: SITE_URL,
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  publisher: { '@id': `${SITE_URL}#organization` },
  inLanguage: 'en-GB',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // Next.js 16: opt in to CSS `scroll-behavior: smooth` while
      // suppressing it during route transitions. Without this
      // attribute Next warns on every route change and Chrome can
      // animate the scroll-to-top on navigation, which looks weird.
      data-scroll-behavior="smooth"
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <head>
        {/* Structured data — emit as script tags rather than metadata
            so Google picks up both nodes under a single JSON array. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([jsonLdOrg, jsonLdSite]),
          }}
        />
      </head>
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
