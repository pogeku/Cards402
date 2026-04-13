import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard/', '/api/', '/portal/'],
      },
    ],
    sitemap: 'https://cards402.com/sitemap.xml',
    host: 'https://cards402.com',
  };
}
