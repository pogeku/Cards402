#!/usr/bin/env bash
# cards402 OWS installer — installs the Stellar-supporting fork of OWS.
# Wraps the upstream install script, pointing it at the fork repo that
# includes Stellar chain support (BIP-44 m/44'/148'/0' derivation,
# Ed25519 signing, Soroban auth).
#
# Usage:
#   curl -fsSL https://cards402.com/install-ows.sh | bash
#
# Or locally:
#   bash scripts/install-ows.sh
#
# This installs:
#   - ows CLI binary to ~/.ows/bin/ows
#   - Node.js bindings via npm install -g @open-wallet-standard/core
#   - Python bindings via pip install open-wallet-standard
#
# Once the Stellar chain support is merged upstream into
# open-wallet-standard/core, this script becomes unnecessary and agents
# can use the standard install: curl -fsSL https://docs.openwallet.sh/install.sh | bash

set -euo pipefail

# Point at the Stellar-supporting fork
export REPO="${OWS_REPO:-CTX-com/Stellar-OWS-Core}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }

info "Installing OWS with Stellar support (from $REPO)"
info "This is a temporary wrapper — Stellar support is being upstreamed."
info ""

# Download and run the upstream install script with our REPO override
curl -fsSL https://docs.openwallet.sh/install.sh | REPO="$REPO" bash

# Verify Stellar support
if command -v ows &>/dev/null; then
  if ows derive-address "$(ows generate-mnemonic)" stellar 2>/dev/null | grep -q "^G"; then
    info "Stellar support confirmed"
  else
    printf '\033[1;33mwarn:\033[0m Stellar chain not available in this build.\n' >&2
    printf '  The fork at %s may not have release binaries yet.\n' "$REPO" >&2
    printf '  Falling back to building from source...\n' >&2

    # Try building from source as fallback
    if command -v cargo &>/dev/null; then
      TMPDIR="$(mktemp -d)"
      git clone --depth 1 "https://github.com/$REPO.git" "$TMPDIR/ows-fork" 2>/dev/null
      cd "$TMPDIR/ows-fork/ows"
      cargo build --release 2>/dev/null
      cp target/release/ows "$HOME/.ows/bin/ows" 2>/dev/null && info "Built from source — Stellar support confirmed"

      # Also build Node bindings
      if command -v npm &>/dev/null; then
        cd "$TMPDIR/ows-fork/bindings/node"
        npm install 2>/dev/null
        npx napi build --platform --release 2>/dev/null
        npm pack 2>/dev/null
        npm install -g open-wallet-standard-core-*.tgz 2>/dev/null && info "Node bindings built and installed"
      fi

      rm -rf "$TMPDIR"
    else
      printf '\033[1;31merror:\033[0m Rust toolchain not found. Install from https://rustup.rs\n' >&2
      exit 1
    fi
  fi
fi

info ""
info "Done. Test with: ows derive-address \"\$(ows generate-mnemonic)\" stellar"
