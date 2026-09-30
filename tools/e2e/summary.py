#!/usr/bin/env python3
"""
A page that covers both device tests.

Two apps are run on the emulator — one showing a web page, one drawing its
screens itself — and each has its own report. This page is the one link to
hand to somebody: it says what was tested, what the verdict was, and points at
the evidence.

It reads only the result files the judge wrote. If a result is missing it says
so and shows the run as failing, because a missing verdict must never look like
a pass.

Usage: summary.py <out-root> <site-dir> <run-number> <commit>
"""
import html
import json
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
SITE = sys.argv[2] if len(sys.argv) > 2 else "site"
RUN = sys.argv[3] if len(sys.argv) > 3 else "?"
SHA = sys.argv[4] if len(sys.argv) > 4 else "?"

STUDIO_URL = "https://deepsilence10161-source.github.io/App-mint-/"

APPS = [
    ("demo", "Website app", "A WebView showing a page bundled inside the app."),
    ("native", "Designed-screens app", "Every view drawn by the app itself, from the screen description."),
]


def read_result(name):
    path = os.path.join(OUT, name, "result.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_build_info(name):
    for candidate in ("build/out/BUILD-INFO.json", "build/native/BUILD-INFO.json"):
        if (name == "demo" and "native" in candidate) or (name == "native" and candidate.endswith("out/BUILD-INFO.json")):
            continue
        if os.path.exists(candidate):
            try:
                with open(candidate) as fh:
                    return json.load(fh)
            except (OSError, ValueError):
                return None
    return None


def fmt(value):
    return html.escape(str(value)) if value is not None else "—"


rows = []
overall_pass = True
for key, title, blurb in APPS:
    result = read_result(key)
    info = read_build_info(key)
    if result is None:
        overall_pass = False
        rows.append((key, title, blurb, None, info))
    else:
        if result.get("verdict") != "PASS":
            overall_pass = False
        rows.append((key, title, blurb, result, info))

cards = []
for key, title, blurb, result, info in rows:
    if result is None:
        verdict_html = '<span class="badge fail">NO RESULT</span><p class="note">No verdict file was produced for this app. That counts as a failure, not a pass.</p>'
    else:
        verdict = result.get("verdict", "FAIL")
        cls = "pass" if verdict == "PASS" else "fail"
        verdict_html = (
            f'<span class="badge {cls}">{fmt(verdict)}</span>'
            f'<p class="note">{fmt(result.get("passed"))}/{fmt(result.get("total"))} checks passed'
            + (f', {fmt(result.get("warned"))} warning(s)' if result.get("warned") else '')
            + '</p>'
        )
    facts = []
    if info:
        facts.append(f'<li><span>Package</span><code>{fmt(info.get("packageName"))}</code></li>')
        facts.append(f'<li><span>Started by</span><code>{fmt(info.get("launcherActivity"))}</code></li>')
        facts.append(f'<li><span>Architecture</span><code>{fmt(info.get("architecture"))}</code></li>')
        if info.get("screens"):
            s = info["screens"]
            facts.append(f'<li><span>Designed screens</span><code>{fmt(s.get("count"))} screens, {fmt(s.get("components"))} components, {fmt(s.get("actions"))} active taps</code></li>')
        facts.append(f'<li><span>Permissions requested</span><code>{len(info.get("permissions") or [])}</code></li>')
        dropped = info.get("permissionsDropped") or []
        if dropped:
            facts.append(f'<li><span>Permissions deliberately not requested</span><code>{len(dropped)}</code></li>')
    cards.append(f"""
    <section class="card">
      <h2>{fmt(title)}</h2>
      <p class="blurb">{fmt(blurb)}</p>
      {verdict_html}
      <ul class="facts">{''.join(facts)}</ul>
      <p><a class="btn" href="./{fmt(key)}/">Open the full report and screenshots →</a></p>
    </section>""")

verdict_banner = ('<div class="banner pass">Both apps ran on a real Android device.</div>'
                  if overall_pass else
                  '<div class="banner fail">At least one app did not pass. Read the reports below.</div>')

document = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App Mint — device test results</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 24px 16px 64px; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0B1020; color: #E8ECF8;
  }}
  .wrap {{ max-width: 760px; margin: 0 auto; }}
  header {{ display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }}
  .mark {{ width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(140deg,#6366F1,#22D3EE); }}
  h1 {{ font-size: 21px; margin: 0; }}
  .sub {{ color: #93A0C0; font-size: 13px; margin: 2px 0 20px; }}
  .banner {{ padding: 12px 14px; border-radius: 12px; font-weight: 650; margin-bottom: 18px; }}
  .banner.pass {{ background: rgba(34,197,94,.14); border: 1px solid rgba(34,197,94,.45); }}
  .banner.fail {{ background: rgba(239,68,68,.14); border: 1px solid rgba(239,68,68,.5); }}
  .card {{ background: #131A2E; border: 1px solid #26304C; border-radius: 16px; padding: 16px; margin-bottom: 16px; }}
  .card h2 {{ font-size: 17px; margin: 0 0 4px; }}
  .blurb {{ color: #93A0C0; font-size: 13px; margin: 0 0 12px; }}
  .badge {{ display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 700; }}
  .badge.pass {{ background: rgba(34,197,94,.18); color: #86EFAC; }}
  .badge.fail {{ background: rgba(239,68,68,.18); color: #FCA5A5; }}
  .note {{ font-size: 13px; color: #93A0C0; margin: 8px 0 0; }}
  ul.facts {{ list-style: none; padding: 0; margin: 14px 0 0; display: grid; gap: 6px; }}
  ul.facts li {{ display: flex; justify-content: space-between; gap: 12px; font-size: 13px; border-bottom: 1px dashed #26304C; padding-bottom: 5px; }}
  ul.facts span {{ color: #93A0C0; }}
  code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }}
  .btn {{ display: inline-block; margin-top: 14px; padding: 12px 16px; border-radius: 12px; text-decoration: none;
          background: rgba(99,102,241,.2); border: 1px solid rgba(99,102,241,.55); color: #C7D2FE; font-weight: 600; }}
  .btn.secondary {{ background: transparent; border-color: #26304C; color: #93A0C0; }}
  footer {{ color: #6B7694; font-size: 12px; margin-top: 26px; line-height: 1.6; }}
  a {{ color: #A5B4FC; }}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="mark"></div>
      <div>
        <h1>App Mint — device test results</h1>
        <p class="sub">Run #{fmt(RUN)} · commit <code>{fmt(str(SHA)[:12])}</code></p>
      </div>
    </header>

    {verdict_banner}

    {''.join(cards)}

    <section class="card">
      <h2>How this was tested</h2>
      <p class="blurb">
        The APKs were built from the specification by the same engine the Studio runs, installed on an
        Android emulator, and driven with real touch input. Screenshots and a screen recording were taken
        while the app was on screen. The pass or fail decision is made by a separate program that reads that
        evidence, so a fault in the driver cannot make a failing app look like a passing one.
      </p>
      <a class="btn" href="../">Open App Mint Studio →</a>
      <a class="btn secondary" href="{STUDIO_URL}" rel="noopener">Studio on GitHub Pages</a>
    </section>

    <footer>
      Free and unlimited: no accounts, no credits, no subscriptions, no AI service to pay for.
      Built and tested by the public build pipelines of this repository.
    </footer>
  </div>
</body>
</html>
"""

os.makedirs(SITE, exist_ok=True)
with open(os.path.join(SITE, "index.html"), "w") as fh:
    fh.write(document)

print(f"summary written to {SITE}/index.html  ({'PASS' if overall_pass else 'FAIL'})")
