# cards402 — Web frontend

Next.js 16 app for [cards402.com](https://cards402.com). Marketing site, API docs, and admin dashboard.

## Development

```bash
npm run dev -w web        # start dev server on :3000
npm run build -w web      # production build
npm run typecheck -w web  # TypeScript check
npm run lint              # ESLint (run from monorepo root)
```

## Environment variables

| Variable                   | Required        | Description                                           |
| -------------------------- | --------------- | ----------------------------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | Production only | Backend API base URL, e.g. `https://api.cards402.com` |

In development the dashboard defaults to `http://localhost:4000` for its API base.

## Structure

```
app/
  page.tsx             Marketing landing page
  docs/                HTTP API reference + quickstart
  dashboard/           Operator dashboard (email OTP auth, redirects to /overview)
  pricing/ company/    Marketing pages (careers, press, security, etc.)
  blog/ changelog/     Editorial surface + RSS feed
  legal/ privacy/ terms/  Legal pages
  components/          Shared UI components
  globals.css          Global styles + brand CSS variables
  layout.tsx           Root layout: fonts, metadata template, JSON-LD
  sitemap.ts robots.ts manifest.ts opengraph-image.tsx
public/
  skill.md             Agent-facing setup guide
  llms.txt             Machine-readable service index
  logo-light.svg       Brand logo (dark-bg variant)
```

## Notes

- Uses `next/font/google` for Fraunces (display), IBM Plex Sans (body), and IBM Plex Mono (data). The build downloads font files from Google Fonts at build time — ensure outbound HTTPS access is available in your build environment.
- The dashboard authenticates via email OTP (6-digit code), session cookie is `sameSite: strict`. The marketing surface is fully public.
- Next.js 16 file conventions are in force: middleware lives in `proxy.ts` at the web root (not `middleware.ts`), and `next/font` is replaced by `next/font/google`/`next/font/local` imports.
