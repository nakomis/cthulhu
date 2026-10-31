#!/usr/bin/env bash
# Build the CthulhuSlicerShim probe .app and register it with LaunchServices.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/build/CthulhuSlicerShim.app"
BIN="$APP/Contents/MacOS/CthulhuSlicerShim"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"

echo "Cleaning old bundle…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "Installing Info.plist…"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

echo "Compiling main.swift…"
swiftc -O "$HERE/Sources/main.swift" -o "$BIN"

echo "Registering with LaunchServices…"
"$LSREGISTER" -f "$APP"

cat <<EOF

Built:  $APP
Log:    ~/Library/Logs/CthulhuSlicerShim/received.log

Register it in SolidCraft:
  Preferences → custom slicers → add:
    $APP
  (or append that path to "custom_slicers" in
   ~/Library/Application Support/SolidCraft/app.ron)

Then in SolidCraft: mark a print face (Ctrl+B) and "Send to Slicer",
choosing Cthulhu Slicer (probe).

Watch what arrives:
  tail -f ~/Library/Logs/CthulhuSlicerShim/received.log

Quit the probe when done:
  killall CthulhuSlicerShim
EOF
