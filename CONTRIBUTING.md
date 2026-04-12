# Contributing

Thanks for wanting to improve cards402. This repo has four main pieces:

| Path | Language | What it does |
|---|---|---|
| `backend/` | Node.js + Express + better-sqlite3 | The 402-payment API that agents talk to |
| `sdk/` | TypeScript | `cards402` npm package + MCP server |
| `web/` | Next.js + TypeScript | Owner dashboard (admin + per-agent views) |
| `contract/` | Rust / Soroban | On-chain receiver contract agents pay into |

And one sibling repo at `../vcc` which does the fulfillment (CTX + scraper).

## Dev setup

```
npm install               # installs all workspaces
cp backend/.env.example backend/.env
cp web/.env.local.example web/.env.local
# fill in the env files — see inline comments for what each var does

npm run dev               # starts backend + web; contract is separate
```

For end-to-end testing you also need vcc running:

```
cd ../vcc/api
cp .env.example .env && edit .env
npm install
node scripts/ctx-auth.js
npm run dev               # starts on :5000
```

## Running tests

| Scope | Command |
|---|---|
| Backend unit + integration | `cd backend && npm test` |
| SDK (vitest) | `cd sdk && npm test` |
| Contract (cargo) | `cd contract && cargo test` |
| Web (vitest + playwright) | `cd web && npm test` |
| All workspaces | `npm test` (from repo root) |

Tests should be fast (whole backend suite < 1s) and never hit real
Stellar / CTX. End-to-end "real money, real Stellar, real scraper" tests
live in `backend/test-batch-e2e.js` — run manually for release validation,
never in CI.

## Style

* **Backend** is plain JavaScript with JSDoc types where useful. No
  TypeScript for now (audit A-1 tracks the debate). Run `npm run lint`
  before pushing.
* **SDK** is strict TypeScript. `npm run typecheck` must pass.
* **Web** is strict TypeScript with Next.js's rules.
* **Contract** follows `cargo fmt` + `cargo clippy -- -D warnings`.
* Prettier enforces JS/TS formatting via a pre-commit hook (husky).
* Commitlint checks commit messages (`feat:`, `fix:`, `docs:`, etc.).

## Commit conventions

Conventional Commits. Prefixes we use frequently:

```
feat(backend): <something>
fix(sdk): <something>
docs(architecture): <something>
test(backend): <something>
chore(deps): <something>
refactor(vcc-client): <something>
```

When closing an audit finding, reference the ID in the commit body:

```
fix(audit-C-4): sign order_id in vcc callbacks

Closes C-4. See docs/audits/2026-04-12-full-findings.md.
```

## PR checklist

- [ ] Tests added / updated for any new behavior
- [ ] `npm test` passes from the repo root
- [ ] `ARCHITECTURE.md` updated if the contract between modules changed
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] `.env.example` updated if you added / renamed an env var
- [ ] If you touched the vcc-cards402 callback protocol: update both
      repos in lockstep and run `backend/test-batch-e2e.js` against the
      real vcc before merging

## Audits

Every so often we run a full audit pass across both repos. Findings are
tracked in `docs/audits/YYYY-MM-DD-*.md`. If you want to work through one,
pick an open `Status: open` finding by its stable ID (e.g. `A-7`, `B-16`,
`C-4`), mark it in-progress, and land a PR referencing the ID. The most
recent full sweep is `docs/audits/2026-04-12-full-findings.md`.

## Questions

Open a GitHub issue or ping the team. For security issues, do NOT open
a public issue — see `SECURITY.md` (when it exists) for the disclosure
process.
