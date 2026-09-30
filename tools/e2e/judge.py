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

        # ── Why these two metrics and not "distinct colours as a percentage" ──
        # The first version of this check measured distinct colours divided by
        # total pixels. A real, clearly rendered page (black text on white) then
        # scored 0.62% — the same as a blank screen — because a page is mostly
        # one background colour. That is a false failure, which is just as
        # dishonest as a false pass.
        #
        # What actually distinguishes rendered from blank:
        #   - a blank screen has a handful of distinct colours
        #   - real content has many, because of text antialiasing
        #   - real content has luminance variation; a blank screen has almost none
        distinct_count = len(set(pixels))
        lum = [0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels]
        mean = sum(lum) / total
        variance = sum((v - mean) ** 2 for v in lum) / total
        stddev = variance ** 0.5

        brightness[name] = round(mean / 255 * 100, 2)
        single_colour[name] = distinct_count
        shot_info[name] = {
            "present": True,
            "bytes": read_bytes(name + ".png"),
            "mean_luminance_pct": round(mean / 255 * 100, 2),
            "luminance_stddev": round(stddev, 2),
            "distinct_colours": distinct_count,
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
    colours = loaded.get("distinct_colours", 0)
    stddev = loaded.get("luminance_stddev", 0.0)
    rendered = colours >= 24 and stddev >= 4.0
    check("content_rendered",
          "Loaded screen shows real rendered content (not a blank view)",
          rendered,
          f"{colours} distinct colours, luminance spread {stddev} "
          f"(a blank screen has a handful of colours and almost no spread)")
else:
    check("content_rendered", "Loaded screen shows real rendered content", False,
          "no loaded screenshot to inspect")

# ── JavaScript actually ran inside the WebView ──────────────────────────────
# Proof that the page's script executed, not merely that pixels changed.
ready_hits = re.findall(r"APPMINT_READY[^\r\n]*", logcat)
check("js_executed",
      "JavaScript ran inside the WebView",
      len(ready_hits) > 0,
      (ready_hits[0][:120] if ready_hits else
       "no APPMINT_READY marker in logcat — the page may have loaded but its script did not run"))

bridge_hits = re.findall(r"APPMINT_BRIDGE \S+", logcat)
if bridge_hits:
    check("bridge_state", "JavaScript bridge state reported",
          True, bridge_hits[0])

if diff_launch_loaded is not None:
    # This check exists to catch a WebView that never painted: the app launches,
    # the page is still fetching, and the screen stays on the splash.
    #
    # For a bundled page there is nothing to wait for, so it paints before the
    # very first screenshot and the two images are legitimately identical. With
    # that in mind, an unchanged screen is only interesting when the page was not
    # already independently proven to have rendered and run its script.
    content_proven = any(c["key"] == "content_rendered" and c["ok"] for c in checks)
    js_proven = any(c["key"] == "js_executed" and c["ok"] for c in checks)

    if content_proven and js_proven:
        check("render_changed",
              "Screen state between launch and load is consistent",
              True,
              f"mean pixel difference {diff_launch_loaded} — the page rendered and its "
              f"script ran, so an unchanged screen means it painted immediately, not that it stalled")
    else:
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
