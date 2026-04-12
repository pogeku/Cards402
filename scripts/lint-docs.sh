#!/usr/bin/env bash
# Checks that documentation and config stay in sync with code.
# Runs in CI — fails the build if things are stale.
set -euo pipefail

ERROR_FILE=$(mktemp)
echo "0" > "$ERROR_FILE"

err() {
  echo "  ERROR: $1" >&2
  count=$(cat "$ERROR_FILE")
  echo "$((count + 1))" > "$ERROR_FILE"
}

# ─── 1. Every env var in backend/src/env.js must be in backend/.env.example ──

echo "Checking env vars..."
grep -E '^\s+[A-Z_]+:' backend/src/env.js | sed 's/[[:space:]]*//' | cut -d: -f1 | while read -r var; do
  if ! grep -q "^${var}=\|^# *${var}" backend/.env.example 2>/dev/null; then
    err "Env var '$var' is in env.js but missing from .env.example"
  fi
done

# ─── 2. Critical source files exist ──────────────────────────────────────────

echo "Checking critical source files exist..."
critical_files=(
  "backend/src/index.js"
  "backend/src/db.js"
  "backend/src/env.js"
  "backend/src/fulfillment.js"
  "backend/src/api/orders.js"
  "backend/src/api/admin.js"
  "backend/src/payments/stellar.js"
  "backend/src/payments/xlm-price.js"
  "backend/src/payments/xlm-sender.js"
  "sdk/src/client.ts"
  "sdk/src/stellar.ts"
  "sdk/src/mcp.ts"
)
for f in "${critical_files[@]}"; do
  if [ ! -f "$f" ]; then
    err "Critical file '$f' does not exist"
  fi
done

# ─── 3. SDK README documents all exported functions ──────────────────────────

echo "Checking SDK README covers exports..."
sdk_exports=$(grep -hE "^export (async )?function|^export (const|class)" sdk/src/client.ts sdk/src/stellar.ts sdk/src/ows.ts 2>/dev/null | \
  sed 's/export async function \([A-Za-z0-9_]*\).*/\1/;s/export function \([A-Za-z0-9_]*\).*/\1/;s/export class \([A-Za-z0-9_]*\).*/\1/;s/export const \([A-Za-z0-9_]*\).*/\1/' | sort -u)
for fn in $sdk_exports; do
  if ! grep -q "\`${fn}\`\|### \`${fn}\`\|\`${fn}(" sdk/README.md 2>/dev/null; then
    err "SDK export '$fn' is not documented in sdk/README.md"
  fi
done

# ─── 4. No stale credential patterns in source (outside .env files) ──────────

echo "Checking for stale credential references in source..."
# X-Admin-Secret / ADMIN_SECRET were removed in favour of email OTP auth
stale=$(grep -rn "X-Admin-Secret\|API_KEY_SECRET" backend/src/ web/app/ admin/app/ sdk/src/ 2>/dev/null | grep -v "node_modules" || true)
if [ -n "$stale" ]; then
  err "Stale credential reference found in source (X-Admin-Secret / API_KEY_SECRET) — auth now uses email OTP (Bearer tokens)"
fi

# ─── 5. backend/.env is not tracked by git ───────────────────────────────────

echo "Checking .env is gitignored..."
if git -C "$(pwd)" ls-files --error-unmatch backend/.env 2>/dev/null; then
  err "backend/.env is tracked by git — it must be in .gitignore"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
errors=$(cat "$ERROR_FILE")
rm -f "$ERROR_FILE"
if [ "$errors" -gt 0 ]; then
  echo "FAILED: $errors issue(s) found."
  exit 1
else
  echo "OK: All documentation checks passed."
fi
