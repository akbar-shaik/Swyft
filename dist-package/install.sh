#!/usr/bin/env bash
set -e

echo "==> Installing CloudIPA CLI..."

INSTALL_DIR="$HOME/.cloudipa-cli"
mkdir -p "$INSTALL_DIR"

TMP_ZIP="/tmp/cloudipa.zip"
curl -fsSL "https://ios.akbr.in/downloads/cloudipa-v1.0.0.zip" -o "$TMP_ZIP" 2>/dev/null || curl -fsSL "http://ios.akbr.in/downloads/cloudipa-v1.0.0.zip" -o "$TMP_ZIP"

unzip -q -o "$TMP_ZIP" -d "$INSTALL_DIR"
rm -f "$TMP_ZIP"

chmod +x "$INSTALL_DIR/bin/cloudipa.js"

# Link or export PATH
BIN_DIR="/usr/local/bin"
if [ -w "$BIN_DIR" ]; then
  ln -sf "$INSTALL_DIR/bin/cloudipa.js" "$BIN_DIR/cloudipa"
  echo "==> Linked executable to $BIN_DIR/cloudipa"
else
  echo ""
  echo "==> Optional: Run sudo ln -sf $INSTALL_DIR/bin/cloudipa.js /usr/local/bin/cloudipa"
  echo "==> Or add to your PATH: export PATH="$INSTALL_DIR/bin:\$PATH""
fi

echo "==> CloudIPA installed successfully! Run 'cloudipa doctor' to verify."
