// Shared SEO helpers. Next.js Metadata API replaces the whole
// `openGraph` object when a child page sets it, so we need a helper
// that produces a fully-populated OG object with the shared brand
// fields baked in. Every marketing page that wants page-specific OG
// title/description calls `ogForPage()` and spreads the result.

import type { Metadata } from 'next';

export const SITE_URL = 'https://cards402.com';
export const SITE_NAME = 'Cards402';

// Canonical OG image URL. The image itself is generated dynamically
// by app/opengraph-image.tsx (Next.js file convention) and served at
// the /opengraph-image route. Keeping this as an absolute URL so it
// resolves correctly in social previews whether the site is visited
// from localhost, a preview deploy, or production.
const OG_IMAGE_URL = `${SITE_URL}/opengraph-image`;

export const SHARED_OG: Metadata['openGraph'] = {
  siteName: SITE_NAME,
  locale: 'en_GB',
  type: 'website',
  images: [
    {
      url: OG_IMAGE_URL,
      width: 1200,
      height: 630,
      alt: 'Cards402 — Virtual Visa cards for AI agents',
    },
  ],
};

export function ogForPage(args: {
  title: string;
  description: string;
  path: string;
}): Metadata['openGraph'] {
  return {
    ...SHARED_OG,
    title: args.title,
    description: args.description,
    url: `${SITE_URL}${args.path}`,
  };
}

// Shared Twitter card with per-page overrides. Same pattern — full
// object replacement, so we bake the site defaults in and let pages
// override title/description.
export const SHARED_TWITTER: Metadata['twitter'] = {
  card: 'summary_large_image',
  site: '@cards402',
  creator: '@cards402',
};

export function twitterForPage(args: { title: string; description: string }): Metadata['twitter'] {
  return {
    ...SHARED_TWITTER,
    title: args.title,
    description: args.description,
  };
}
