#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# App Mint — on-device smoke test driver
# ─────────────────────────────────────────────────────────────────────────────
# Installs the generated APK on a real Android emulator, drives it with real
# touch input, and collects evidence: screenshots, a screen recording, logcat.
#
# This script NEVER decides pass or fail. tools/e2e/judge.py does that from the
# collected evidence, so nothing here can turn a failure green.
#
# Runs inside reactivecircus/android-emulator-runner as ONE shell script.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PKG="${APP_PACKAGE:-com.appmint.demo}"
ACT="${APP_ACTIVITY:-$PKG.MainActivity}"
OUT="${OUT_DIR:-out}"
mkdir -p "$OUT"

: > "$OUT/steps.txt"
: > "$OUT/recoveries.txt"

step() { echo "[$(date +%T)] $*" | tee -a "$OUT/steps.txt"; }

step "package=$PKG activity=$ACT"
echo "unknown" > "$OUT/emulator-version.txt"
grep -h '^Pkg.Revision' "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}/emulator/source.properties" \
  > "$OUT/emulator-version.txt" 2>/dev/null || true
adb devices

# ── wait for a genuinely booted device ──────────────────────────────────────
step "waiting for boot"
for i in $(seq 1 90); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
# A half-booted launcher throws ANRs over whatever is on screen, so let it settle.
sleep 15
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put secure immersive_mode_confirmations confirmed || true
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true

W=$(adb shell wm size 2>/dev/null | grep -oE '[0-9]+x[0-9]+' | tail -1 | cut -dx -f1)
H=$(adb shell wm size 2>/dev/null | grep -oE '[0-9]+x[0-9]+' | tail -1 | cut -dx -f2)
echo "${W}x${H}" > "$OUT/screen.txt"
step "screen ${W}x${H}"

# ── install ─────────────────────────────────────────────────────────────────
APK=$(ls build/apk/*.apk 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "no apk found in build/apk/" > "$OUT/install.log"
  echo "1" > "$OUT/install-rc.txt"
  exit 0
fi
step "install $(basename "$APK") ($(stat -c%s "$APK") bytes)"
adb install -r -g "$APK" > "$OUT/install.log" 2>&1
echo $? > "$OUT/install-rc.txt"
cat "$OUT/install.log"
adb logcat -c || true

# ── helpers ─────────────────────────────────────────────────────────────────
shot() {
  adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null
  step "  screenshot $1 ($(stat -c%s "$OUT/$1.png" 2>/dev/null || echo 0) bytes)"
}
dismiss_anr() {
  if adb shell dumpsys window 2>/dev/null | grep -qE "Application Not Responding|Not Responding:"; then
    adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
    XY=$(adb shell cat /sdcard/ui.xml 2>/dev/null | python3 tools/e2e/find_wait.py)
    if [ -n "$XY" ]; then
      adb shell input tap $XY
      echo "anr-dismissed at $XY ($(date +%T))" >> "$OUT/recoveries.txt"
      sleep 2
    else
      echo "anr-seen-no-wait-button ($(date +%T))" >> "$OUT/recoveries.txt"
    fi
  fi
}
top_activity() {
  adb shell dumpsys activity activities 2>/dev/null \
    | grep -m1 -E "topResumedActivity|ResumedActivity" | tr -d '\r'
}
ensure_front() {
  for k in 1 2 3; do
    dismiss_anr
    TOP=$(top_activity)
    echo "$TOP" | grep -q "$PKG" && return 0
    echo "relaunch#$k top=[$TOP] ($(date +%T))" >> "$OUT/recoveries.txt"
    adb shell am start -n "$PKG/$ACT" > /dev/null 2>&1
    sleep 8
  done
  return 1
}

# ── start the screen recording before the app appears ───────────────────────
adb shell screenrecord --time-limit 170 --bit-rate 2000000 --size "${W}x${H}" /sdcard/e2e.mp4 \
  > "$OUT/screenrecord.log" 2>&1 &
REC=$!
sleep 1

# ── launch ──────────────────────────────────────────────────────────────────
step "launch"
adb shell am start -W -n "$PKG/$ACT" > "$OUT/start.log" 2>&1 || true
cat "$OUT/start.log"

sleep 2
ensure_front
shot 01-launch

# ── give the WebView time to fetch and paint ────────────────────────────────
step "waiting for the page to render"
for i in $(seq 1 30); do
  if adb logcat -d 2>/dev/null | grep -qiE "chromium|WebView|onPageFinished|Console"; then break; fi
  sleep 2
done
sleep 12
ensure_front
shot 02-loaded

# ── pull to refresh (real touch gesture) ────────────────────────────────────
step "pull to refresh"
adb shell input swipe $((W/2)) $((H*35/100)) $((W/2)) $((H*75/100)) 400 || true
sleep 6
ensure_front
shot 03-refreshed

# ── back navigation must not crash the app ──────────────────────────────────
step "back press"
adb shell input keyevent KEYCODE_BACK || true
sleep 3
ensure_front
shot 04-after-back

# ── rotation ────────────────────────────────────────────────────────────────
step "rotate to landscape"
adb shell settings put system accelerometer_rotation 0 || true
adb shell settings put system user_rotation 1 || true
sleep 5
ensure_front
shot 05-landscape

step "rotate back to portrait"
adb shell settings put system user_rotation 0 || true
sleep 4
ensure_front
shot 06-portrait

# ── stop recording, collect evidence ────────────────────────────────────────
adb shell pkill -2 screenrecord > /dev/null 2>&1 || true
sleep 4
kill $REC 2>/dev/null || true
wait $REC 2>/dev/null || true
adb pull /sdcard/e2e.mp4 "$OUT/e2e.mp4" > /dev/null 2>&1 || true
step "video $(stat -c%s "$OUT/e2e.mp4" 2>/dev/null || echo 0) bytes"

PID=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r\n')
if [ -n "$PID" ]; then echo alive > "$OUT/app-state.txt"; else echo dead > "$OUT/app-state.txt"; fi
echo "$PID" > "$OUT/app-pid.txt"

adb logcat -d > "$OUT/logcat.txt" 2>/dev/null || true
adb shell dumpsys package "$PKG" > "$OUT/package-dump.txt" 2>/dev/null || true

# Evidence collected. The verdict belongs to judge.py.
exit 0
