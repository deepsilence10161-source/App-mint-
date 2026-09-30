#!/usr/bin/env python3
"""
Build a phone-friendly HTML report from the on-device test evidence.

Deliberately mobile-first: this is viewed on a phone, so the screenshots lead,
the verdict is unmissable, and nothing needs scrolling sideways.

Usage: report.py <out_dir> <site_dir> <run_number> <sha> [repo]
"""
import base64
import json
import os
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "out"
site = sys.argv[2] if len(sys.argv) > 2 else "site"
run_number = sys.argv[3] if len(sys.argv) > 3 else "?"
sha = sys.argv[4] if len(sys.argv) > 4 else "?"
repo = sys.argv[5] if len(sys.argv) > 5 else "deepsilence10161-source/App-mint-"

os.makedirs(site, exist_ok=True)
os.makedirs(os.path.join(site, "shots"), exist_ok=True)


def load_result():
    path = os.path.join(out, "result.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


result = load_result()

SHOTS = [
    ("01-launch", "Launch"),
    ("02-loaded", "Page loaded"),
    ("03-refreshed", "After pull-to-refresh"),
    ("04-after-back", "After back press"),
    ("05-landscape", "Landscape"),
    ("06-portrait", "Portrait"),
]

# Copy screenshots next to the report so the page is self-contained on Pages.
available = []
for name, label in SHOTS:
    src = os.path.join(out, name + ".png")
    if os.path.exists(src) and os.path.getsize(src) > 1000:
        dst = os.path.join(site, "shots", name + ".png")
        with open(src, "rb") as fh:
            data = fh.read()
        with open(dst, "wb") as fh:
            fh.write(data)
        available.append((name, label, f"shots/{name}.png", len(data)))

video_src = os.path.join(out, "e2e.mp4")
video_size = os.path.getsize(video_src) if os.path.exists(video_src) else 0
if video_size > 10000:
    import shutil
    shutil.copy(video_src, os.path.join(site, "e2e.mp4"))

verdict = (result or {}).get("verdict", "NO RESULT")
passed = (result or {}).get("passed", 0)
total = (result or {}).get("total", 0)
checks = (result or {}).get("checks", [])

V_COLOUR = {"PASS": "#16a34a", "FAIL": "#dc2626", "NO RESULT": "#6b7280"}.get(verdict, "#6b7280")

rows = []
for c in checks:
    mark = "PASS" if c.get("ok") else ("WARN" if c.get("severity") == "warn" else "FAIL")
    colour = {"PASS": "#16a34a", "WARN": "#d97706", "FAIL": "#dc2626"}[mark]
    ev = (c.get("evidence") or "").replace("<", "&lt;").replace(">", "&gt;")
    rows.append(f"""
      <li>
        <span class="badge" style="background:{colour}">{mark}</span>
        <div class="ck">
          <div class="lbl">{c.get('label','')}</div>
          <div class="ev">{ev}</div>
        </div>
      </li>""")

gallery = "".join(f"""
      <figure>
        <img src="{path}" alt="{label}" loading="lazy">
        <figcaption>{label} <span class="dim">{size // 1024} KB</span></figcaption>
      </figure>""" for _n, label, path, size in available)

video_block = ""
if video_size > 10000:
    video_block = f"""
    <section class="card">
      <h2>Screen recording</h2>
      <video controls playsinline preload="metadata" src="e2e.mp4"></video>
      <p class="dim">Recorded live on the emulator. {video_size // 1024} KB.</p>
    </section>"""

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>App Mint — device test {verdict}</title>
<style>
  * {{ box-sizing: border-box; }}
  :root {{
    --bg: #0B1020; --card: #151B2E; --fg: #E8ECF8; --dim: #94A3B8;
    --accent: #22D3EE; --line: #23304d;
  }}
  @media (prefers-color-scheme: light) {{
    :root {{ --bg:#F5F7FB; --card:#FFFFFF; --fg:#0F172A; --dim:#5B6B84; --line:#E2E8F0; }}
  }}
  body {{
    margin:0; background:var(--bg); color:var(--fg);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height:1.5; -webkit-text-size-adjust:100%;
    padding: 16px 14px 48px; max-width: 900px; margin-inline:auto;
  }}
  header {{ text-align:center; padding: 8px 0 20px; }}
  .verdict {{
    display:inline-block; font-weight:800; font-size:2rem; letter-spacing:.02em;
    color:{V_COLOUR}; margin: 4px 0 6px;
  }}
  .sub {{ color:var(--dim); font-size:.875rem; }}
  .card {{
    background:var(--card); border:1px solid var(--line); border-radius:16px;
    padding:16px; margin: 0 0 16px;
  }}
  h2 {{ font-size:1rem; margin:0 0 12px; font-weight:700; }}
  ul {{ list-style:none; padding:0; margin:0; }}
  li {{ display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--line); align-items:flex-start; }}
  li:last-child {{ border-bottom:0; }}
  .badge {{
    font-size:.625rem; font-weight:800; color:#fff; border-radius:6px;
    padding:3px 7px; flex:0 0 auto; margin-top:2px; letter-spacing:.04em;
  }}
  .ck {{ min-width:0; }}
  .lbl {{ font-size:.9375rem; font-weight:600; }}
  .ev {{ font-size:.8125rem; color:var(--dim); word-break:break-word; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }}
  figure {{ margin:0; }}
  figure img {{ width:100%; border-radius:12px; border:1px solid var(--line); display:block; background:#000; }}
  figcaption {{ font-size:.75rem; color:var(--dim); margin-top:6px; text-align:center; }}
  video {{ width:100%; border-radius:12px; background:#000; }}
  .dim {{ color:var(--dim); }}
  a.btn {{
    display:inline-block; margin-top:6px; background:var(--accent); color:#04202a;
    font-weight:700; text-decoration:none; padding:11px 18px; border-radius:11px;
    font-size:.9375rem;
  }}
  code {{ background:rgba(125,125,125,.15); padding:1px 5px; border-radius:5px; font-size:.85em; }}
</style>
</head>
<body>
  <header>
    <div class="dim" style="font-size:.75rem;letter-spacing:.08em;text-transform:uppercase">App Mint · device test</div>
    <div class="verdict">{verdict}</div>
    <div class="sub">{passed} of {total} checks passed · run #{run_number} · <code>{sha[:8]}</code></div>
  </header>

  <section class="card">
    <h2>What was checked</h2>
    <ul>{''.join(rows) or '<li><span class="badge" style="background:#6b7280">—</span><div class="ck"><div class="lbl">No results</div><div class="ev">The judge produced no output.</div></div></li>'}</ul>
  </section>

  <section class="card">
    <h2>Screenshots from the emulator</h2>
    <p class="sub" style="margin:0 0 12px">Captured with <code>adb exec-out screencap</code> on a real Android {os.environ.get('ANDROID_API_LEVEL','')} emulator — not a mock-up.</p>
    <div class="grid">{gallery or '<p class="dim">No screenshots were captured.</p>'}</div>
  </section>
  {video_block}

  <section class="card">
    <h2>Reproduce this yourself</h2>
    <p class="sub">Every run is reproducible from the repository, and the emulator is free on public repositories.</p>
    <a class="btn" href="https://github.com/{repo}/actions">Open GitHub Actions</a>
  </section>

  <footer class="sub" style="text-align:center;padding-top:8px">
    <a class="btn" style="background:#1B2338;color:#E9EEFB;margin-bottom:10px"
       href="../">Open App Mint Studio</a><br>
    Generated by App Mint · deterministic build, honest verdict
  </footer>
</body>
</html>
"""

if not available:
    # Nothing to build a meaningful page from.
    pass

with open(os.path.join(site, "index.html"), "w") as fh:
    fh.write(html)

# A machine-readable copy as well, so nothing depends on parsing HTML.
with open(os.path.join(site, "result.json"), "w") as fh:
    json.dump(result or {"verdict": "NO RESULT", "checks": []}, fh, indent=2)

print(f"report written to {site}/index.html ({verdict}, {passed}/{total})")
