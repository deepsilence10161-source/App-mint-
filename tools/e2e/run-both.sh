#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run BOTH kinds of generated app in one emulator session.
# ─────────────────────────────────────────────────────────────────────────────
# A website app and a designed-screens app do not share a single line of UI
# code: one is a WebView, the other draws every view itself. Testing only one
# of them would leave the other, and the whole screen designer behind it,
# proven only by a compiler.
#
# Booting the emulator is the expensive part, so both apps are installed and
# driven inside the same session, each into its own evidence directory.
#
# As with run.sh, this script does not decide anything. judge.py does.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
stage="${STAGE_DIR:-build/apk}"

run_one() {
  local label="$1" apk="$2" pkg="$3" act="$4" out="out/$1"
  local kind="" tabs=0 info=""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  $label — $pkg"
  echo "══════════════════════════════════════════════════════════════════"
  mkdir -p "$out"
  if [ ! -f "$apk" ]; then
    echo "::error::$label: no APK at $apk"
    echo "no-apk" > "$out/install-failed.txt"
    return 1
  fi
  # A previous app must not be left on the device: two builds sharing a package
  # name with different signatures is the classic INSTALL_FAILED_UPDATE_INCOMPATIBLE.
  adb uninstall "$pkg" >/dev/null 2>&1 || true
  if ! adb install -r -t "$apk" > "$out/install.log" 2>&1; then
    echo "::error::$label: the APK would not install"
    cp "$out/install.log" "$out/install-failed.txt" 2>/dev/null || true
    return 1
  fi
  # What the app IS decides how it is driven, and the answer comes from the
  # generated project rather than from a guess in the workflow.
  info="build/$([ "$label" = "native" ] && echo native || echo out)/BUILD-INFO.json"
  kind=$(facts "$info" architecture)
  tabs=0
  tab_names=""
  if [ "$kind" = "native-screens" ]; then
    kind=native
    tabs=$(node -e "const b=require('./' + process.argv[1]); console.log((b.screens && b.screens.tabs && b.screens.tabs.length) || 0)" "$info" 2>/dev/null)
    tabs=${tabs:-0}
    tab_names=$(node -e "const b=require('./' + process.argv[1]); console.log(((b.screens && b.screens.tabs) || []).join('|'))" "$info" 2>/dev/null)
  fi
  # The report needs the same facts the driver used.
  cp "$info" "$out/BUILD-INFO.json" 2>/dev/null || true
  echo "  kind=$kind tabs=$tabs labels=[$tab_names]"

  SKIP_INSTALL=1 APP_KIND="$kind" APP_TABS="$tabs" APP_TAB_NAMES="$tab_names" \
    APP_PACKAGE="$pkg" APP_ACTIVITY="$act" OUT_DIR="$out" bash "$here/run.sh"
  adb uninstall "$pkg" >/dev/null 2>&1 || true
  return 0
}

# The facts come from the generated projects, not from guesses: BUILD-INFO.json
# is written by the generator and names the package and the activity that
# actually starts the app.
facts() {   # facts <build-info.json> <field>
  node -e "console.log(require('./' + process.argv[1])[process.argv[2]] || '')" "$1" "$2" 2>/dev/null
}

demo_pkg=$(facts build/out/BUILD-INFO.json packageName)
demo_act=$(facts build/out/BUILD-INFO.json launcherActivity)
native_pkg=$(facts build/native/BUILD-INFO.json packageName)
native_act=$(facts build/native/BUILD-INFO.json launcherActivity)

echo "demo:   $demo_pkg / $demo_act"
echo "native: $native_pkg / $native_act"

run_one demo   "$stage/demo.apk"   "$demo_pkg"   "$demo_act"
run_one native "$stage/native.apk" "$native_pkg" "$native_act"

echo "both apps driven"
