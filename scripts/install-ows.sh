#!/usr/bin/env bash
# cards402 OWS installer — installs the Stellar-supporting fork of OWS.
#
# Usage:
#   curl -fsSL https://cards402.com/install-ows.sh | bash
#
# This downloads a prebuilt binary for your platform from:
#   https://github.com/CTX-com/Stellar-OWS-Core/releases
#
# Supports: macOS (ARM + Intel), Linux (x86_64 + ARM64)

set -euo pipefail

REPO="${OWS_REPO:-CTX-com/Stellar-OWS-Core}"
INSTALL_DIR="${OWS_INSTALL_DIR:-$HOME/.ows/bin}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      err "unsupported OS: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)             err "unsupported architecture: $arch" ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM="$(detect_platform)"
TAG="v1.3.0-stellar"
URL="https://github.com/${REPO}/releases/download/${TAG}/ows-${PLATFORM}"

info "Installing OWS with Stellar support"
info "Platform: ${PLATFORM}"
info "Source: ${URL}"

mkdir -p "$INSTALL_DIR"
TMPFILE="$(mktemp)"

if ! curl -fsSL -o "$TMPFILE" "$URL"; then
  rm -f "$TMPFILE"
  err "Failed to download binary. Check https://github.com/${REPO}/releases"
fi

chmod +x "$TMPFILE"
mv "$TMPFILE" "${INSTALL_DIR}/ows"

# Add to PATH if not already there
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  info "Adding ${INSTALL_DIR} to PATH"
  SHELL_NAME="$(basename "$SHELL")"
  RC_FILE="$HOME/.bashrc"
  [[ "$SHELL_NAME" == "zsh" ]] && RC_FILE="$HOME/.zshrc"
  echo "export PATH=\"${INSTALL_DIR}:\$PATH\"" >> "$RC_FILE"
  export PATH="${INSTALL_DIR}:$PATH"
fi

info ""
info "Installed: $(ows --version)"
info ""

# Verify Stellar support
if ows wallet create --name _stellar_probe 2>/dev/null | grep -q "stellar:pubnet"; then
  ows wallet delete --name _stellar_probe --yes 2>/dev/null || true
  info "Stellar chain support confirmed"
else
  ows wallet delete --name _stellar_probe --yes 2>/dev/null || true
  info "Warning: Stellar chain not detected in this build"
fi

info ""
info "Done. Create a wallet with: ows wallet create --name my-agent"
