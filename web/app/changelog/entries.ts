// Shared source of truth for the /changelog page and its RSS feed
// handler. Both surfaces import from here so adding an entry is a
// single-file change. Next.js ignores non-route filenames inside the
// app/ tree, so this plain .ts file doesn't accidentally become a
// URL segment.
//
// New entries go at the TOP of the array. Dates are ISO (YYYY-MM-DD)
// and stay as plain strings so we can serialise them to both
// BlogPosting.datePublished (ISO) and RSS pubDate (RFC 822) without
// timezone drift.

export type ChangelogTag = 'feature' | 'fix' | 'api' | 'security' | 'infra';

export interface ChangelogEntry {
  date: string;
  version?: string;
  title: string;
  tags: ChangelogTag[];
  body: string;
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    date: '2026-04-14',
    title: 'First blog post: anatomy of a Cards402 order',
    tags: ['feature'],
    body: 'New /blog index plus the first real post — a walk-through of the median 33-second path from purchaseCardOWS() through Stellar, the watcher, Stage 1/2 fulfilment, and the SSE stream, with the P50 timings we see on mainnet today. Cross-posted to the changelog RSS feed.',
  },
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
