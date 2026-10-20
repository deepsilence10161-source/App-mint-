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

# 3) custom icon bake — Pillow से (runner में imagemagick नहीं होता, exit 127 से बचो)
if [ -n "$ICON_URL" ]; then
  curl -fsSL "$ICON_URL" -o /tmp/icon.png
  python3 -m pip install --quiet pillow 2>/dev/null || true
  python3 - "/tmp/icon.png" <<'PY'
from PIL import Image
import sys, os
img = Image.open(sys.argv[1]).convert("RGBA")
if img.size[0] != img.size[1]:            # non-square → center crop
    s = min(img.size)
    l, t = (img.size[0]-s)//2, (img.size[1]-s)//2
    img = img.crop((l, t, l+s, t+s))
for d, px in {"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}.items():
    out = f"app/src/main/res/mipmap-{d}"
    os.makedirs(out, exist_ok=True)
    img.resize((px, px), Image.LANCZOS).save(f"{out}/ic_launcher.png", "PNG")
# adaptive-vector PNGs को ढक देता है (API 26+ पर v26 priority) → custom icon के साथ हटाना ज़रूरी
p = "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"
if os.path.exists(p):
    os.remove(p)
print("  ✅ icon baked (your image, all densities)")
PY
fi
