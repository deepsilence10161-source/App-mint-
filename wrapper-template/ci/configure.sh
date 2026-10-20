#!/usr/bin/env bash
# ⚡ AppKaro build configure — permissions inject, theme color, icon bake
# Usage: configure.sh "<PERMISSIONS_CSV>" "<#RRGGBB>" "<icon_url|>"
set -euo pipefail

PERMS="${1:-NOTIFICATIONS}"
COLOR="${2:-#6C5CE7}"
ICON_URL="${3:-}"

cd "$(dirname "$0")/.."
echo "⚙️  configure: perms='$PERMS' color='$COLOR' icon='${ICON_URL:-<default>}'"

# 1) optional permissions → manifest marker
python3 - "$PERMS" <<'PY'
import io, sys
m = {
  "NOTIFICATIONS": ["android.permission.POST_NOTIFICATIONS"],
  "CAMERA": ["android.permission.CAMERA"],
  "MIC": ["android.permission.RECORD_AUDIO"],
  "LOCATION": ["android.permission.ACCESS_FINE_LOCATION",
                "android.permission.ACCESS_COARSE_LOCATION"],
}
lines = []
for key in sys.argv[1].split(","):
    key = key.strip().upper()
    for p in m.get(key, []):
        lines.append(f'    <uses-permission android:name="{p}" />')
if lines:
    p = "app/src/main/AndroidManifest.xml"
    s = io.open(p, encoding="utf-8").read()
    s = s.replace("<!-- EXTRA_PERMISSIONS -->", "\n".join(lines))
    io.open(p, "w", encoding="utf-8").write(s)
    print("  ✅ injected:", ", ".join(l.split('"')[1] for l in lines))
PY

# 2) theme color (default #6C5CE7 को replace)
if [ -n "$COLOR" ]; then
  sed -i "s/#6C5CE7/${COLOR}/g" \
    app/src/main/res/values/colors.xml \
    app/src/main/res/values/ic_launcher_background.xml
  echo "  ✅ theme color: $COLOR"
fi

# 3) custom icon bake (ubuntu runner में imagemagick preinstalled)
if [ -n "$ICON_URL" ]; then
  curl -fsSL "$ICON_URL" -o /tmp/icon.png
  for sz in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
    d="${sz%%:*}"; px="${sz##*:}"
    mkdir -p "app/src/main/res/mipmap-$d"
    convert /tmp/icon.png -resize "${px}x${px}" "app/src/main/res/mipmap-$d/ic_launcher.png"
  done
  echo "  ✅ icon baked"
fi
