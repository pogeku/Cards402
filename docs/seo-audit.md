# Cards402 SEO audit — 2026-04-14

Audit performed after the phase 1–3 site build. Scope is technical SEO and
on-page SEO for marketing routes; product analytics and content strategy are
out of scope.

**Updated during loop iteration 2** — items marked 🟢 have landed since
the initial audit. See the bottom of this doc for the delta.

## Score summary

| Area                           | Status | Notes                                                                     |
| ------------------------------ | :----: | ------------------------------------------------------------------------- |
| Crawlability (robots/sitemap)  |   ✅   | `sitemap.ts` + `robots.ts` live, 13 URLs                                  |
| Canonical URLs                 |   ✅   | Every new page sets `alternates.canonical`                                |
| Title uniqueness               |   ✅   | Each page has a distinct `<title>` via template                           |
| Meta descriptions              |   ✅   | Hand-written, ≤ 160 chars, per page                                       |
| H1 hierarchy                   |   ✅   | Exactly one H1 per page, verified via curl                                |
| OG / Twitter cards             |   ✅   | Per-page overrides via `ogForPage()` helper                               |
| OG image                       |   ✅   | Dynamic 1200×630 via `opengraph-image.tsx`                                |
| Structured data (Organization) |   ✅   | JSON-LD on every page via layout                                          |
| Structured data (WebSite)      |   ✅   | Ditto                                                                     |
| Structured data (FAQPage)      |   ✅   | `/pricing`                                                                |
| Structured data (Product)      |   ✅   | `/pricing`                                                                |
| Structured data (JobPosting)   |   ✅   | `/careers` (one entry per role)                                           |
| Structured data (Breadcrumb)   |   ⚠️   | Not yet — see gap list                                                    |
| `hreflang`                     |   ⚠️   | English-only; no alt-lang tags                                            |
| Page performance               |   ⚠️   | Not measured yet — need to run Lighthouse against prod                    |
| Mobile viewport                |   ✅   | All pages have working responsive layouts                                 |
| Internal link structure        |   ✅   | Footer links every new route; nav dropdown surfaces them all              |
| `rel="noopener"` on externals  |   ✅   | All external links use `rel="noreferrer"` or `noopener`                   |
| Semantic HTML                  |   ✅   | `<header>`, `<section>`, `<article>`, `<time>`, `<dl>` used appropriately |

## What's live now

### Files added

- `app/sitemap.ts` — static sitemap listing 13 marketing/legal routes
- `app/robots.ts` — allow-all with `/dashboard/`, `/api/`, `/portal/` disallowed
- `app/manifest.ts` — PWA manifest (name, colours, icon)
- `app/opengraph-image.tsx` — dynamic 1200×630 edge-rendered social card
- `app/lib/seo.ts` — shared OG/Twitter helpers to work around Next.js's
  non-recursive openGraph merging
- Organization + WebSite JSON-LD in `app/layout.tsx` (single `<script>` with
  both entities in one array)

### Title template

Root layout defines `title: { default, template: '%s — Cards402' }`. Pages
export `metadata.title: 'Pricing'` and Next.js renders
`<title>Pricing — Cards402</title>`. No page repeats the brand in its own
title string — avoids the `Pricing — Cards402 — Cards402` bug.

### Open Graph image behaviour

Next.js's Metadata API does a **shallow** merge on `openGraph`: a child
setting `openGraph` at all replaces the parent's entire object, including
images and site name. Naively we lost the OG image on every overriding page.

**Fix:** `app/lib/seo.ts` exports `SHARED_OG` (images, siteName, locale,
type) plus `ogForPage({ title, description, path })` which spreads shared
fields into a new object with the page-specific title/desc/url on top. Every
page that wants its own OG now calls `ogForPage()` instead of writing the
openGraph literal.

The image itself is referenced as `https://cards402.com/opengraph-image` —
the route that the `opengraph-image.tsx` file convention exposes. Edge-
rendered, cached by Next.js between requests.

## Gaps / follow-ups

### Quick wins

1. **BreadcrumbList structured data.** Trivial to add on pages that sit
   inside a section (`/docs/quickstart`, `/legal/cardholder-agreement`).
   Boosts SERP rendering.
2. **`hreflang="en-gb"` + `hreflang="x-default"`** on every canonical URL.
   Cheap once, useful when non-English pages eventually land.
3. **`Article` JSON-LD** on `/changelog` entries — turns each into a
   timestamped article Google can index individually. Requires splitting
   entries into sub-routes or using anchor fragments.
4. **`robots.ts` add `crawlDelay` removed** — good, no crawl delay. Consider
   adding an AI-specific directive block for GPTBot and friends once we have
   a policy.
5. **Favicon variants.** Only `icon.png` is served (258×258). Add
   `icon-16.png`, `icon-32.png`, `apple-touch-icon-180.png` so browsers
   don't scale the 258px raster.
6. **OG image reuses IBM Plex Mono font tag.** The dynamic `ImageResponse`
   falls back to Georgia because we don't ship a font binary. Either embed
   Fraunces + IBM Plex Sans as base64 blobs for richer previews, or accept
   Georgia as close enough — the call.
7. **Per-page OG images.** Right now every route uses the same static OG
   card. `/pricing` and `/careers` could have page-specific ones via nested
   `opengraph-image.tsx` files; `/changelog` could get one per entry.
8. **JSON-LD WebSite.potentialAction** — add `SearchAction` if we build a
   site-wide search so Google exposes a site search box in the SERP.

### Medium

9. **Preload hero fonts.** Next.js `next/font/google` already hashes and
   self-hosts, but we can add `fontDisplay: 'swap'` and `adjustFontFallback:
true` to both Fraunces and Plex if they aren't already. Verify.
10. **CSS image-rendering hint for the wordmark.** The wordmark is a CSS
    mask over an SVG; on some Chromes it shows faint aliasing at small
    sizes. Add `image-rendering: crisp-edges` on the mask span or bake a
    second PNG variant for hi-DPI display.
11. **Status page** at `status.cards402.com`. Referenced from Terms but
    doesn't exist yet. Important for enterprise trust and for Google's
    "service status" SERP chips.
12. **Security.txt.** Add `/.well-known/security.txt` pointing at
    `security@cards402.com` so researchers find us without clicking through
    to /security.
13. **`humans.txt`** — optional, vanity, but cheap.
14. **Blog.** `/blog` with real technical posts would become our strongest
    SEO asset after 6 months. Out of scope for this pass.

### Bigger

15. **Lighthouse/CWV pass on prod.** Once deployed, run Lighthouse against
    `/`, `/docs`, `/pricing` and drive LCP < 2.5s, CLS < 0.1, INP < 200ms.
    Likely wins: smaller OG image, font preloading, lazy-load the HeroCard
    tilt JS below the fold.
16. **Server-rendered SVG for OG image.** `ImageResponse` is SSR but
    re-renders on every request unless cached. Consider generating static
    PNGs at build time for the per-page variants.
17. **Sitemap splitting.** Currently one `sitemap.xml` — fine for <50k URLs.
    If we add per-changelog-entry pages, split into `sitemap-pages.xml` +
    `sitemap-changelog.xml` via a sitemap index.
18. **Internationalisation (`next-intl` or similar)** — adds a `[locale]`
    segment to every route and switches content per locale. Not yet
    urgent; document before touching.

## Loop iteration 2 delta — 2026-04-14

Everything below was marked as a gap in the original audit and has since
been implemented. Leaving the gap list above intact as historical
context; this section is the running log of what's now ✅.

- 🟢 **BreadcrumbList structured data** — live on `/docs/quickstart` and
  `/legal/cardholder-agreement`. Pairs with the page titles so Google
  shows `Cards402 › Docs › Quickstart` in the SERP.
- 🟢 **`hreflang="en-GB"` + `hreflang="x-default"`** — added via
  `alternates.languages` in `app/layout.tsx`. Ready to accept real
  locale URLs once we translate.
- 🟢 **Keywords meta removed.** Google has ignored it since ~2009 and
  it was drifting out of sync with on-page copy.
- 🟢 **`/.well-known/security.txt`** — researchers land here with the
  disclosure contact, expiry, and policy link. Expires 2027-04-14.
- 🟢 **`humans.txt`** — served at the root, credits the team, mirrors
  the brand.
- 🟢 **`llms.txt`** — emerging standard for AI/LLM content discovery.
  Placed at the root with an exact-structure document index per the
  draft spec (<https://llmstxt.org>). Perfect-fit audience.
- 🟢 **Custom 404 + error boundary** — `not-found.tsx` with
  `robots: noindex` so Google doesn't catalogue the fallback, plus a
  route-level `error.tsx` that surfaces the Next.js error digest as a
  support reference ID.
- 🟢 **`Article` / BlogPosting JSON-LD on changelog entries.** Each
  entry is now wrapped in an `ItemList` with `BlogPosting` children,
  and the `<article>` elements have stable hash-fragment ids matching
  the JSON-LD URLs. Google can index them individually.
- 🟢 **RSS feed at `/changelog/feed.xml`** — RSS 2.0 route handler
  with per-entry guids and a 1h edge cache. Feed-reader auto-discovery
  wired via `alternates.types` on the changelog head, so pasting
  `/changelog` into NetNewsWire picks it up.
- 🟢 **Status page (`/status`)** — closed the dangling reference from
  the Terms page to `status.cards402.com`. Component-by-component
  health + worst-of banner + subscribe block.
- 🟢 **`/skill.md`** — was a 404 referenced from the landing hero CTA.
  Now a real agent-onboarding brief.

### Still open from the original gaps list

- ⚠️ Per-page OG images (nested `opengraph-image.tsx` at `/pricing`,
  `/careers`, `/changelog`).
- ⚠️ Font preloading + `adjustFontFallback: true` on Fraunces / Plex.
- ⚠️ Status page at `status.cards402.com` (the real dashboard, not the
  Cards402-hosted summary on `/status`).
- ⚠️ Lighthouse/CWV pass on prod.
- ⚠️ Internationalisation (next-intl).
- ⚠️ Blog.
- ⚠️ Embed Fraunces/Plex base64 into `opengraph-image.tsx` so the
  social card isn't Georgia-fallback.

## What I'd NOT do

- **Don't add keyword meta tags.** They're still in the layout from my
  earlier pass — mostly harmless but Google ignores them. Could be removed.
- **Don't chase AMP.** Dead format, hurts more than helps.
- **Don't paywall docs** behind a sign-in. Hurts SEO and goodwill equally.
- **Don't hide real information behind JS.** Every marketing page currently
  renders its content in the initial HTML response; keep it that way.

## Verification commands

```bash
# All new routes return 200
for r in / /docs /docs/quickstart /pricing /company /careers /press \
         /security /privacy /terms /changelog /affiliate \
         /legal/cardholder-agreement /sitemap.xml /robots.txt \
         /manifest.webmanifest /opengraph-image; do
  printf "%-35s " "$r"
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000$r"
done

# Each page has exactly one <h1>
for r in / /docs /pricing /company /careers /press /security /privacy \
         /terms /changelog /affiliate /legal/cardholder-agreement \
         /docs/quickstart; do
  h1=$(curl -s "http://localhost:3000$r" | grep -oE '<h1' | wc -l)
  printf "%-35s h1=%s\n" "$r" "$h1"
done

# JSON-LD is valid JSON
curl -s http://localhost:3000/pricing \
  | grep -oE '<script type="application/ld\+json"[^>]*>[^<]*' \
  | sed 's|<script[^>]*>||' | jq -r type
```
