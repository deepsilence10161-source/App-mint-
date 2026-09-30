#!/usr/bin/env python3
"""
Turn result.json into a CI exit status.

Kept as its own file rather than an inline heredoc so indentation can never
silently break it, and so the exact same gate can be run by hand locally.

Exit 0 only when the verdict is PASS. Any missing result is a FAILURE — a
missing verdict must never be read as a pass.
"""
import json
import os
import sys

path = os.path.join(sys.argv[1] if len(sys.argv) > 1 else "out", "result.json")

if not os.path.exists(path):
    print("::error::No verdict file was produced. Treating this as a failure, not a pass.")
    sys.exit(1)

with open(path) as fh:
    result = json.load(fh)

for check in result.get("checks", []):
    if not check.get("ok"):
        level = "warning" if check.get("severity") == "warn" else "error"
        print(f"::{level}::{check['key']}: {check['label']} — {check['evidence']}")

print(f"\n{result.get('verdict')}  {result.get('passed')}/{result.get('total')} checks passed, "
      f"{result.get('warnings', 0)} warning(s)")

sys.exit(0 if result.get("verdict") == "PASS" else 1)
