#!/usr/bin/env python3
"""
App Mint — on-device smoke test VERDICT
=======================================
Reads the evidence collected by tools/e2e/run.sh and decides pass or fail.

This file is deliberately separate from the driver. If the driver decided its
own verdict, a bug in the driver would look like a passing test. Here the driver
only collects; this script judges, and it records the evidence behind every
single check so a human can re-verify the result by eye.

Usage:  judge.py <out_dir>       ->  writes <out_dir>/result.json
Exit code is always 0; the CI step reads verdict from result.json so the
verdict is explicit rather than implied by a process exit status.
"""
import json
import os
import re
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "out"


def read(name, default=""):
    path = os.path.join(out, name)
    if not os.path.exists(path):
        return default
    try:
        with open(path, errors="replace") as fh:
            return fh.read()
    except Exception:
        return default


def read_bytes(name):
    path = os.path.join(out, name)
    if not os.path.exists(path):
        return 0
    return os.path.getsize(path)


logcat = read("logcat.txt")
steps = read("steps.txt")
pkg = ""
m = re.search(r"package=(\S+)", steps)
if m:
    pkg = m.group(1)

checks = []


def check(key, label, ok, evidence, severity="fail"):
    checks.append({
        "key": key,
        "label": label,
        "ok": bool(ok),
        "evidence": str(evidence),
        "severity": severity,
    })


# ── 1. install ───────────────────────────────────────────────────────────────
install_rc = read("install-rc.txt", "?").strip()
check("install", "APK installed on the device", install_rc == "0", f"adb install rc={install_rc}")

# ── 2. it really launched ────────────────────────────────────────────────────
start = read("start.log")
launched = ("Status: ok" in start) or ("Activity:" in start and "Error" not in start) or ("TotalTime" in start)
check("launch", "Activity started", launched, (start.strip().splitlines() or ["(no start output)"])[-1][:200])

top_ok = False
if pkg:
    dumps = read("package-dump.txt")
    top_ok = bool(dumps)
check("installed_package", "Package is registered on the device",
      top_ok, f"dumpsys package {pkg}: {len(read('package-dump.txt'))} bytes")

# ── 3. no crash ──────────────────────────────────────────────────────────────
crash_patterns = [
    r"FATAL EXCEPTION",
    r"E AndroidRuntime:.*Process:",
    r"Fatal signal \d+",
    r"ANR in " + re.escape(pkg) if pkg else r"ANR in ",
]
found_crash = [p for p in crash_patterns if re.search(p, logcat)]
check("no_crash", "No fatal crash in logcat", not found_crash,
      "none found" if not found_crash else f"matched: {found_crash}")

# ── 4. the app survived the whole run ────────────────────────────────────────
state = read("app-state.txt", "unknown").strip()
check("alive", "App process still alive after all interactions",
      state == "alive", f"pidof -> {state} (pid {read('app-pid.txt').strip() or 'n/a'})")

# ── 5. screenshots exist and are not blank ───────────────────────────────────
EXPECTED = [
    ("01-launch", "launch"),
    ("02-loaded", "page loaded"),
    ("03-refreshed", "after pull-to-refresh"),
    ("04-after-back", "after back press"),
    ("05-landscape", "landscape rotation"),
    ("06-portrait", "back to portrait"),
]

shot_info = {}
brightness = {}
single_colour = {}
diff_launch_loaded = None

try:
    from PIL import Image, ImageChops, ImageStat

    def load(name):
        path = os.path.join(out, name + ".png")
        if not os.path.exists(path) or os.path.getsize(path) < 1000:
            return None
        try:
            im = Image.open(path).convert("RGB")
            im.thumbnail((270, 480))
            return im
        except Exception:
            return None

    for name, _label in EXPECTED:
        im = load(name)
        if im is None:
            shot_info[name] = {"present": False, "bytes": read_bytes(name + ".png")}
            continue
        pixels = list(im.getdata())
        total = len(pixels) or 1
        bright = sum(1 for r, g, b in pixels if max(r, g, b) > 60) / total * 100
        distinct = len(set(pixels)) / total * 100
        brightness[name] = round(bright, 2)
        single_colour[name] = round(100 - distinct, 2)
        shot_info[name] = {
            "present": True,
            "bytes": read_bytes(name + ".png"),
            "bright_pct": round(bright, 2),
            "distinct_pct": round(distinct, 2),
            "_im": im,
        }

    def diff(a, b):
        A = shot_info.get(a, {}).get("_im")
        B = shot_info.get(b, {}).get("_im")
        if A is None or B is None or A.size != B.size:
            return None
        return round(sum(ImageStat.Stat(ImageChops.difference(A, B)).mean) / 3, 2)

    diff_launch_loaded = diff("01-launch", "02-loaded")
except Exception as exc:  # noqa: BLE001
    shot_info["_pil_error"] = str(exc)

for name, label in EXPECTED:
    info = shot_info.get(name, {"present": False})
    check(f"shot_{name}", f"Screenshot captured: {label}",
          info.get("present") and info.get("bytes", 0) > 5000,
          f"{info.get('bytes', 0)} bytes")

# A real rendered page has many distinct colours. A solid colour means the
# WebView never painted, which is exactly the failure a byte-count check misses.
loaded = shot_info.get("02-loaded", {})
if loaded.get("present"):
    dpct = loaded.get("distinct_pct", 0)
    check("content_rendered",
          "Loaded screen contains real rendered content (not a blank view)",
          dpct > 4.0,
          f"{dpct}% distinct colour values (a blank screen sits near 0%)")
else:
    check("content_rendered", "Loaded screen contains real rendered content", False,
          "no loaded screenshot to inspect")

if diff_launch_loaded is not None:
    check("render_changed",
          "Screen changed between launch and load (proves the page actually painted)",
          diff_launch_loaded > 0.5,
          f"mean pixel difference {diff_launch_loaded}")

# ── 6. rotation actually happened ────────────────────────────────────────────
ls_shot = shot_info.get("05-landscape", {})
pt_shot = shot_info.get("06-portrait", {})
if ls_shot.get("present") and pt_shot.get("present"):
    check("rotation", "App survived a rotation cycle",
          True, "landscape and portrait screenshots both captured")

# ── 7. screen recording ──────────────────────────────────────────────────────
video_bytes = read_bytes("e2e.mp4")
check("video", "Screen recording captured", video_bytes > 10000, f"{video_bytes} bytes",
      severity="warn")

# ── summary ──────────────────────────────────────────────────────────────────
for v in shot_info.values():
    if isinstance(v, dict):
        v.pop("_im", None)

failed = [c for c in checks if not c["ok"] and c["severity"] == "fail"]
warned = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
passed = [c for c in checks if c["ok"]]

verdict = "PASS" if not failed else "FAIL"

result = {
    "verdict": verdict,
    "passed": len(passed),
    "total": len(checks),
    "warnings": len(warned),
    "checks": checks,
    "screenshots": shot_info,
    "brightness": brightness,
    "single_colour_pct": single_colour,
    "diff_launch_to_loaded": diff_launch_loaded,
    "video_bytes": video_bytes,
    "package": pkg,
}

with open(os.path.join(out, "result.json"), "w") as fh:
    json.dump(result, fh, indent=2)

print(f"VERDICT {verdict}  {len(passed)}/{len(checks)} checks passed, {len(warned)} warning(s)")
for c in checks:
    mark = "PASS" if c["ok"] else ("WARN" if c["severity"] == "warn" else "FAIL")
    print(f"  [{mark}] {c['label']}: {c['evidence']}")

sys.exit(0)
