#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing CloudIPA CLI..."

INSTALL_DIR="$HOME/.cloudipa-cli"
mkdir -p "$INSTALL_DIR"

TMP_ZIP="/tmp/cloudipa.zip"
curl -fsSL "https://ios.akbr.in/downloads/cloudipa-v1.0.0.zip" -o "$TMP_ZIP" 2>/dev/null || curl -fsSL "http://ios.akbr.in/downloads/cloudipa-v1.0.0.zip" -o "$TMP_ZIP"

unzip -q -o "$TMP_ZIP" -d "$INSTALL_DIR"
rm -f "$TMP_ZIP"

chmod +x "$INSTALL_DIR/bin/cloudipa.js" 2>/dev/null || true

# If package.json has dependencies and bundle is not standalone, install without dev
if [ -f "$INSTALL_DIR/package.json" ] && [ ! -f "$INSTALL_DIR/dist/cli.js" ]; then
  (cd "$INSTALL_DIR" && npm install --omit=dev --ignore-scripts 2>/dev/null || true)
fi

BIN_DIR="/usr/local/bin"
if [ -w "$BIN_DIR" ]; then
  ln -sf "$INSTALL_DIR/bin/cloudipa.js" "$BIN_DIR/cloudipa"
  echo "==> Successfully linked executable to $BIN_DIR/cloudipa"
else
  echo ""
  echo "==> To make cloudipa globally accessible, run:"
  echo "    sudo ln -sf $INSTALL_DIR/bin/cloudipa.js /usr/local/bin/cloudipa"
  echo "    or add to your shell profile: export PATH="$INSTALL_DIR/bin:\$PATH""
fi

echo "==> CloudIPA installed successfully! Run 'cloudipa doctor' to verify."
