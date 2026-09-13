#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_ROOT="${TRAVEL_INSTALL_DIR:-$HOME/Library/Application Support/TravelAssistant}"
if [ "$(uname -s)" != Darwin ]; then
  echo '本地安装器支持 macOS；Linux 请使用 docker compose up -d --build。' >&2
  exit 1
fi
mkdir -p "$INSTALL_ROOT/runtime"
chmod 700 "$INSTALL_ROOT"
if [ ! -x "$INSTALL_ROOT/runtime/bin/node" ] || [ "$("$INSTALL_ROOT/runtime/bin/node" --version)" != v24.13.0 ]; then
  ARCH="$(uname -m)"; [ "$ARCH" != x86_64 ] || ARCH=x64
  NODE_ARCHIVE="node-v24.13.0-darwin-$ARCH.tar.gz"
  DOWNLOAD_DIR="$(mktemp -d)"
  trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
  curl -fSL "https://nodejs.org/dist/v24.13.0/$NODE_ARCHIVE" -o "$DOWNLOAD_DIR/$NODE_ARCHIVE"
  curl -fSL https://nodejs.org/dist/v24.13.0/SHASUMS256.txt -o "$DOWNLOAD_DIR/SHASUMS256.txt"
  (cd "$DOWNLOAD_DIR" && awk -v archive="$NODE_ARCHIVE" '$2 == archive' SHASUMS256.txt | shasum -a 256 -c -)
  tar -xzf "$DOWNLOAD_DIR/$NODE_ARCHIVE" -C "$INSTALL_ROOT/runtime" --strip-components=1
fi
export PATH="$INSTALL_ROOT/runtime/bin:$PATH"
cd "$ROOT"
node scripts/bootstrap.mjs
TRAVEL_INSTALL_DIR="$INSTALL_ROOT" node scripts/install-local.mjs "$@"
