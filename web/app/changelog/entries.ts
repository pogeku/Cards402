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
    title: 'Security + correctness audit — 18 fixes across backend and SDK',
    tags: ['security', 'fix', 'infra'],
    body: "An end-to-end audit of the security-critical primitives and the agent-facing SDK, covering the backend webhook layer, auth middleware, HMAC signing, card-at-rest sealing, SSRF guard, policy engine, error sanitiser, and every CLI surface operators touch. Eighteen commits shipped. Highlights: (1) Outbound HTTPS webhooks were silently failing in production — the DNS-pinning code rewrote the URL hostname to the resolved IP, which broke TLS certificate verification for every webhook endpoint with a CA-issued cert. Dropped the rewrite, kept the SSRF validation; the DNS-rebinding window is back but narrow and well-understood. (2) Auth middleware now blocks suspended keys at every /v1/* route — previously `suspended` was only enforced at order-creation time, so read endpoints let flagged agents straight through. (3) SSRF guard was missing IPv4-mapped IPv6, fe80::/10 past fe80, IPv4 multicast (224/4), reserved ranges, broadcast, and the RFC 5737 doc prefixes. Rewrote on Node's built-in net.BlockList with 19 regression tests. (4) Card-vault sealed blobs are now shape-validated (truncated rows no longer throw an opaque TypeError), and per-field decrypt errors are labelled so ops can pinpoint which order and which column is corrupt. (5) Policy engine fails closed on NaN/negative amounts and corrupt numeric policy columns — previously both silently disabled rules. (6) `/vcc-callback` rate limiter was a single global bucket; bucket by IP so attackers can't starve legitimate callbacks. (7) `/auth/me` no longer shares a rate-limit budget with `/auth/login`, so dashboard browsing from NAT'd networks stops hitting 429s. (8) SDK sweep: CLI amount bounds match backend ($0.01 / $10,000), `--asset auto` added to `purchase` + MCP, config writes are now atomic with re-tightened perms, `waitForCard` no longer doubles its timeout on SSE fallback, onboard refuses to silently overwrite existing credentials. (9) Enhanced /status endpoint returns live 24h delivery + watcher freshness, and a real /status page + status.cards402.com subdomain route. Backend suite went from ~200 tests to 336; new regression guards shipped alongside every fix.",
  },
  {
    date: '2026-04-14',
    version: 'sdk@0.4.7',
    title: 'SDK 0.4.7 — self-updating CLI warning + @latest everywhere in the docs',
    tags: ['feature', 'fix'],
    body: 'The CLI now prints a one-line stderr warning on every invocation if your installed version is older than the latest on npm. The check fires in the background with a 2s fetch timeout, caches its result in ~/.cards402/version-check.json for 24h, and never blocks or fails the actual command — stdout is untouched so scripts parsing CLI output are unaffected. Every operator-facing install snippet across skill.md, the quickstart, the landing page, the dashboard claim-code drawer, the developer page, llms.txt, and the examples README now pins @latest on npx so each invocation re-resolves against the registry instead of serving a stale cached version. The practical effect: when we ship an SDK patch release (like 0.4.6 which unblocked USDC purchases), agents onboarded under the new instructions pick it up on their next run instead of having to wait for the npx cache to expire or for the operator to manually nuke it.',
  },
  {
    date: '2026-04-14',
    version: 'sdk@0.4.6',
    title: 'SDK 0.4.6 — stop stranding agents on failed Soroban transactions',
    tags: ['fix', 'api'],
    body: 'Two bugs in the SDK\'s Soroban submit path were combining to leave agents polling forever on orders whose payment never actually landed. (1) FAILED statuses from getTransaction were swallowed by a catch-block intended for XDR version errors, so the poll loop ran to the 120s deadline. (2) The deadline-timeout branch attached a txHash to its error unconditionally, which purchaseCardOWS treated as "envelope may still land" — so transactions that had already failed on-chain or never made it into a ledger still triggered the waitForCard fall-through. Fixed by re-raising terminal throws out of the poll loop and only attaching txHash when Horizon itself is unreachable. Package exports now declare both `import` and `require` so CommonJS consumers don\'t trip on ERR_PACKAGE_PATH_NOT_EXPORTED. Upgrade with `npx -y cards402@latest` or `npm i cards402@latest`.',
  },
  {
    date: '2026-04-14',
    title: 'New post: claim codes — credentials that never touch the transcript',
    tags: ['feature'],
    body: 'Security-architecture post on why Cards402 onboards agents with single-use claim codes instead of raw API keys. The failure mode (keys in LLM chat transcripts), the three options we considered (OAuth, env-only instructions, one-time exchange tokens), why we picked the last one, and what else building the primitive unlocked.',
  },
  {
    date: '2026-04-14',
    title: 'New post: why SSE beats polling for agent-facing APIs',
    tags: ['feature'],
    body: 'Why the Cards402 SDK defaults to Server-Sent Events for order state, why we kept polling as an automatic fallback, and the operational details (keepalive interval, nginx buffering, terminal close) that make SSE reliable in practice when your clients are long-lived processes instead of browsers.',
  },
  {
    date: '2026-04-14',
    title: 'New post: non-custodial card issuance on Soroban',
    tags: ['feature'],
    body: "Architectural walk-through of the Cards402 receiver contract, the Soroban event watcher, and the refund story. Why agents pay a contract we can't drain, what we gave up on the latency side, and why the trade was worth it for a payment platform aimed at autonomous agents.",
  },
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
