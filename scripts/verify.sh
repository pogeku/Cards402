#!/usr/bin/env bash
set -euo pipefail

echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ===" && npm run lint
echo "=== SDK build ===" && npm run build -w sdk
echo "=== Test ===" && npm test
echo "=== Backend Test ===" && (cd backend && npm test)
echo "=== Docs ===" && ./scripts/lint-docs.sh
echo ""
echo "ALL CHECKS PASSED"
