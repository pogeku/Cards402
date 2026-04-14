import type { MetadataRoute } from 'next';

const SITE = 'https://cards402.com';

// Static marketing + legal pages. The dashboard and API routes are
// intentionally excluded — they're not meant to be indexed. New
// marketing routes should be added here in the order they appear in
// the footer so the sitemap reads naturally.
const ROUTES: Array<{
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
  priority: number;
}> = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/docs', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/docs/quickstart', changeFrequency: 'monthly', priority: 0.85 },
  { path: '/pricing', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/status', changeFrequency: 'hourly', priority: 0.75 },
  { path: '/blog', changeFrequency: 'weekly', priority: 0.75 },
  {
    path: '/blog/anatomy-of-a-cards402-order',
    changeFrequency: 'monthly',
    priority: 0.7,
  },
  { path: '/changelog', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/company', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/careers', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/press', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/affiliate', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/legal/cardholder-agreement', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
