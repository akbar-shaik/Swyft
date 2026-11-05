import os
import zipfile
import tarfile
import shutil
import subprocess

print("==> Building and bundling CloudIPA...")
subprocess.run("npm run build", shell=True, check=True)
subprocess.run("npm run bundle", shell=True, check=True)

os.makedirs('dist-package', exist_ok=True)
os.makedirs('web', exist_ok=True)

# 1. Create self-contained install.sh
install_sh = """#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing CloudIPA CLI..."

INSTALL_DIR="$HOME/.cloudipa-cli"
mkdir -p "$INSTALL_DIR"

TMP_ZIP="/tmp/cloudipa.zip"
curl -fsSL "https://ios.akbr.in/downloads/cloudipa-v1.0.0.zip" -o "$TMP_ZIP" 2>/dev/null || \
curl -fsSL "http://ios.akbr.in/downloads/cloudipa-v1.0.0.zip" -o "$TMP_ZIP"

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
  echo "    or add to your shell profile: export PATH=\"$INSTALL_DIR/bin:\$PATH\""
fi

echo "==> CloudIPA installed successfully! Run 'cloudipa doctor' to verify."
"""

with open('dist-package/install.sh', 'w', newline='\n', encoding='utf-8') as f:
    f.write(install_sh)

shutil.copyfile('dist-package/install.sh', 'web/install.sh')

# 2. Create ZIP package
zip_path = 'dist-package/cloudipa-v1.0.0.zip'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('package.json', 'package.json')
    z.write('README.md', 'README.md')
    z.write('bin/cloudipa.js', 'bin/cloudipa.js')
    z.write('templates/cloudipa-build.yml', 'templates/cloudipa-build.yml')
    z.write('dist-package/install.sh', 'install.sh')
    for root, dirs, files in os.walk('dist'):
        for f in files:
            p = os.path.join(root, f)
            arcname = os.path.relpath(p, '.')
            z.write(p, arcname)
print(f"Created {zip_path} ({os.path.getsize(zip_path)} bytes)")

# 3. Create TAR.GZ package
tar_path = 'dist-package/cloudipa-v1.0.0.tar.gz'
with tarfile.open(tar_path, 'w:gz') as t:
    t.add('package.json', arcname='cloudipa/package.json')
    t.add('README.md', arcname='cloudipa/README.md')
    t.add('bin/cloudipa.js', arcname='cloudipa/bin/cloudipa.js')
    t.add('templates/cloudipa-build.yml', arcname='cloudipa/templates/cloudipa-build.yml')
    t.add('dist-package/install.sh', arcname='cloudipa/install.sh')
    t.add('dist', arcname='cloudipa/dist')
print(f"Created {tar_path} ({os.path.getsize(tar_path)} bytes)")

# 4. Create sample demo unsigned .ipa
demo_ipa_path = 'dist-package/CloudIPA-Demo.unsigned.ipa'
with zipfile.ZipFile(demo_ipa_path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('Payload/CloudIPADemo.app/Info.plist', """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.cloudipa.demoapp</string>
    <key>CFBundleName</key>
    <string>CloudIPADemo</string>
    <key>CFBundleDisplayName</key>
    <string>CloudIPA Demo</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>MinimumOSVersion</key>
    <string>15.0</string>
</dict>
</plist>""")
    z.writestr('Payload/CloudIPADemo.app/CloudIPADemo', b'\xca\xfe\xba\xbeSampleBinaryContent')
print(f"Created {demo_ipa_path} ({os.path.getsize(demo_ipa_path)} bytes)")
print("==> Packaging completed successfully.")
