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

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Production only | Backend API base URL, e.g. `https://api.cards402.com` |

In development the admin page defaults to `http://localhost:4000`.

## Structure

```
app/
  page.tsx          Marketing landing page
  docs/page.tsx     API reference docs
  admin/page.tsx    Internal ops dashboard (protected by email OTP auth)
  components/       Shared UI components
  globals.css       Global styles + CSS variables
public/
  agents.txt        Machine-readable service description for AI agents
```

## Notes

- The web app uses `next/font/google` (Geist). The build downloads font files from Google Fonts at build time — ensure outbound HTTPS access is available in your build environment.
- The admin dashboard is not authenticated at the network level; protect `/admin` via Cloudflare Access or similar if exposed publicly.
