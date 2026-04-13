// RSS 2.0 feed for /changelog. Keeps the entries in sync with the
// page by importing from a shared data module... except we currently
// inline the entries in the page component. When we move them to a
// shared source-of-truth (database, JSON file, MDX frontmatter),
// this route becomes a one-liner that iterates the same array.
//
// For now, we duplicate the entries here rather than pulling them
// from the page component to keep the route handler tree-shake
// friendly — server-rendered pages bring in JSX dependencies this
// route doesn't need.

const SITE = 'https://cards402.com';
const SITE_NAME = 'Cards402';

type Tag = 'feature' | 'fix' | 'api' | 'security' | 'infra';

const ENTRIES: Array<{
  date: string;
  version?: string;
  title: string;
  tags: Tag[];
  body: string;
}> = [
  {
    date: '2026-04-14',
    title: 'Site overhaul: pricing, legal, security, careers',
    tags: ['feature'],
    body: 'New marketing + legal surface. Pricing page with the full Pathward fee breakdown, dedicated Security, Company, Careers, Press, and Affiliate pages. Plain-English cardholder agreement summary. Sitemap, robots, and structured data for search.',
  },
  {
    date: '2026-04-13',
    title: 'Docs redesign & brand polish',
    version: '1.2.0',
    tags: ['feature'],
    body: 'Docs page rewritten onto the Fraunces/IBM Plex type system with editorial section scaffolding. New favicon, Cards402 casing swept across every user-visible surface, notification tray with empty state, login form now submits on Enter.',
  },
  {
    date: '2026-04-13',
    title: 'Email logo visibility on dark background',
    tags: ['fix'],
    body: 'Transactional emails now load a pre-tinted /logo-light.svg variant so the wordmark renders on the dark email template instead of collapsing to an invisible black mask.',
  },
  {
    date: '2026-04-12',
    title: 'Dashboard polish: overflow fixes + microinteractions',
    tags: ['feature'],
    body: 'KPI tile hover lift, row accent on table hover, horizontal scroll hint on borderless cards, theme toggle hides on iPhone-SE-class viewports.',
  },
  {
    date: '2026-04-11',
    title: 'Hero card with parallax tilt',
    tags: ['feature'],
    body: 'New hero section with a lerped-cursor parallax-tilted virtual card and full load-in choreography. Wrap entry, outline draw, glow pulse, fill, content lift, float idle.',
  },
  {
    date: '2026-04-10',
    title: 'Cards402 brand refresh',
    version: '1.1.0',
    tags: ['feature'],
    body: 'New wordmark rendered via CSS mask for theme-aware colouring. Fraunces display + IBM Plex Sans body + IBM Plex Mono data. Darker canvas, muted mint accent, grain overlay, radial glows.',
  },
  {
    date: '2026-04-08',
    title: 'Architecture v2 — agents pay VCC directly',
    version: '1.0.0',
    tags: ['api', 'security'],
    body: 'Non-custodial payment flow: agents now sign and submit Soroban contract invocations directly to the receiver contract. Cards402 proxies the 402 response and observes on-chain events. No funds held in intermediate custody.',
  },
  {
    date: '2026-04-05',
    title: 'First live order on mainnet',
    tags: ['infra'],
    body: 'First end-to-end live order on Stellar mainnet. $0.02 to verify the pipeline, ~33s from payment to PAN. Five watcher bugs found and fixed in the process.',
  },
  {
    date: '2026-04-02',
    title: 'SSE phase stream + waitForCard()',
    tags: ['api', 'feature'],
    body: 'New /orders/:id/stream endpoint pushing order state over Server-Sent Events with a 15-second keepalive comment. SDK waitForCard() defaults to SSE with automatic polling fallback.',
  },
  {
    date: '2026-03-28',
    title: 'Claim-code onboarding',
    tags: ['feature', 'security'],
    body: 'Single-use claim codes replace raw API keys in the agent onboarding flow. Operators mint a claim, share it once, the agent exchanges it for a real key on first boot. Credentials never hit the LLM transcript.',
  },
];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// RSS 2.0 uses RFC 822 dates. JavaScript's toUTCString is close but
// uses "GMT" which is accepted by all reasonable feed readers.
function rfc822(iso: string): string {
  return new Date(iso + 'T09:00:00Z').toUTCString();
}

export async function GET() {
  const newest = ENTRIES[0];
  const lastBuild = newest ? rfc822(newest.date) : new Date().toUTCString();
  const items = ENTRIES.map((e) => {
    const guid = `${SITE}/changelog#${e.date}-${e.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}`;
    const titlePrefix = e.version ? `v${e.version} — ` : '';
    return `
    <item>
      <title>${escapeXml(titlePrefix + e.title)}</title>
      <link>${SITE}/changelog</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${rfc822(e.date)}</pubDate>
      <category>${e.tags.map(escapeXml).join(', ')}</category>
      <description>${escapeXml(e.body)}</description>
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME} changelog</title>
    <link>${SITE}/changelog</link>
    <atom:link href="${SITE}/changelog/feed.xml" rel="self" type="application/rss+xml" />
    <description>Everything shipped to Cards402. API changes, dashboard polish, security fixes, and upstream-issuer updates — chronologically.</description>
    <language>en-GB</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <generator>Cards402 changelog route</generator>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      // Cache for an hour at the edge. Route handlers that read no
      // request-time data are already statically optimised by Next.js;
      // this header is a belt-and-braces for any intermediary.
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
