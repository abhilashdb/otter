#!/usr/bin/env bash
# Build Otter.app — a double-clickable macOS launcher with the otter icon.
#
# It compiles a tiny AppleScript applet that opens Terminal and runs the local
# stack (scripts/otter.command), then dresses it with an .icns generated from
# assets/otter-icon.svg. Re-run this any time the icon or repo path changes.
#
# Output: Otter.app at the repo root (gitignored). Drag it to /Applications, the
# Dock, or the Desktop — it launches the full stack and opens the browser.
#
# Requires: rsvg-convert (brew install librsvg), iconutil + osacompile (built in).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/Otter.app"
ICON_SVG="$ROOT/assets/otter-icon.svg"

command -v rsvg-convert >/dev/null || { echo "✗ rsvg-convert missing — run: brew install librsvg"; exit 1; }
[ -f "$ICON_SVG" ] || { echo "✗ icon not found: $ICON_SVG"; exit 1; }

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

echo "▶ Compiling launcher applet…"
rm -rf "$APP"
SCPT="$BUILD/otter.applescript"
cat > "$SCPT" <<APPLESCRIPT
on run
	tell application "Terminal"
		activate
		do script "clear; exec " & quoted form of "$ROOT/scripts/otter.command"
	end tell
end run
APPLESCRIPT
osacompile -o "$APP" "$SCPT"

echo "▶ Rendering icon…"
ICONSET="$BUILD/Otter.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size"  -h "$size"          "$ICON_SVG" -o "$ICONSET/icon_${size}x${size}.png"
  rsvg-convert -w $((size*2)) -h $((size*2))   "$ICON_SVG" -o "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$BUILD/Otter.icns"
cp "$BUILD/Otter.icns" "$APP/Contents/Resources/applet.icns"

# Recent osacompile also bakes the default applet icon into an asset catalog
# (Assets.car + CFBundleIconName), which the OS prefers over applet.icns. Drop
# both so our applet.icns (CFBundleIconFile) is the one that shows.
rm -f "$APP/Contents/Resources/Assets.car"
plutil -remove CFBundleIconName "$APP/Contents/Info.plist" 2>/dev/null || true

# Nudge Finder/Dock to pick up the new icon (clear its cache + re-register).
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

echo "✓ Built $APP"
echo "  Drag it to /Applications or your Dock, or double-click it in Finder."
