#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RS_DIR="$ROOT/.rs-build"
RS_BRANCH="feature/extension-auth-broker"
RS_REPO="https://github.com/remotestorage/remotestorage.js.git"
VENDOR_DIR="$ROOT/packages/demo-app/vendor"
PORT="${PORT:-5173}"

echo "==> remoteStorage extension demo builder"
echo ""

# ── 1. Clone or update remotestorage.js ──
if [ -d "$RS_DIR/.git" ]; then
  echo "--- Updating existing remotestorage.js clone"
  cd "$RS_DIR"
  git fetch origin "$RS_BRANCH" --quiet
  git checkout "$RS_BRANCH" --quiet
  git reset --hard "origin/$RS_BRANCH" --quiet
else
  echo "--- Cloning remotestorage.js ($RS_BRANCH)"
  rm -rf "$RS_DIR"
  git clone --branch "$RS_BRANCH" --single-branch --depth 1 "$RS_REPO" "$RS_DIR"
fi

# ── 2. Install deps and build ──
cd "$RS_DIR"
echo "--- Installing dependencies"
npm install --ignore-scripts --no-audit --no-fund --loglevel=error 2>&1

echo "--- Building release bundle"
npx webpack --config webpack.config.js --mode production 2>&1

if [ ! -f "$RS_DIR/release/remotestorage.js" ]; then
  echo "ERROR: Build did not produce release/remotestorage.js"
  exit 1
fi

# ── 3. Copy bundle to demo vendor dir ──
mkdir -p "$VENDOR_DIR"
cp "$RS_DIR/release/remotestorage.js" "$VENDOR_DIR/remotestorage.js"
if [ -f "$RS_DIR/release/remotestorage.js.map" ]; then
  cp "$RS_DIR/release/remotestorage.js.map" "$VENDOR_DIR/remotestorage.js.map"
fi
echo "--- Copied bundle to $VENDOR_DIR"

# ── 4. Serve demo ──
cd "$ROOT"
echo ""
echo "==> Demo app ready"
echo "    Extension: load packages/extension/ as unpacked extension in chrome://extensions"
echo "    Demo app:  http://127.0.0.1:$PORT"
echo ""
node scripts/serve-demo.mjs
