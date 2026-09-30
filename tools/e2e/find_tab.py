#!/usr/bin/env python3
"""
Find a point to tap, from what is actually on the screen.

Why this exists
---------------
Tapping a tab by arithmetic — "the bar is about 60dp tall, so aim 56px from the
bottom" — is a guess. It is wrong as soon as the system navigation bar takes
space at the bottom, the density differs, or the bar wraps to two lines, and
being wrong here means the tap lands on the system buttons, the app leaves the
foreground, and the test reports a failure that is really a miscalculation.

So instead of guessing, ask the device what is on screen. `uiautomator dump`
gives every node's bounds and its text. This finds the node whose text or
content description matches the label we are looking for, and returns the centre
of it — which is what a finger would hit.

Reads the UI dump on stdin, writes "x y" on stdout, and prints nothing (exit 1)
when there is no match, so the caller can fall back and say that it did.

Usage:  find_tab.py "Home"   <  ui.xml
"""
import re
import sys
import xml.etree.ElementTree as ET

BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


def centre(bounds):
    m = BOUNDS.match(bounds or "")
    if not m:
        return None
    x1, y1, x2, y2 = (int(g) for g in m.groups())
    if x2 <= x1 or y2 <= y1:
        return None
    return ((x1 + x2) // 2, (y1 + y2) // 2, y1, y2)


def main():
    wanted = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    if not wanted:
        return 1
    raw = sys.stdin.read()
    if not raw.strip():
        return 1
    # uiautomator occasionally emits an unescaped ampersand; a failed parse
    # should mean "not found", never a traceback that looks like a test crash.
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raw = re.sub(r"&(?!amp;|lt;|gt;|quot;|apos;|#)", "&amp;", raw)
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            return 1

    matches = []
    for node in root.iter("node"):
        text = (node.get("text") or "").strip().lower()
        desc = (node.get("content-desc") or "").strip().lower()
        if wanted not in (text, desc):
            continue
        found = centre(node.get("bounds"))
        if found:
            x, y, top, bottom = found
            matches.append((x, y, top, bottom))

    if not matches:
        return 1

    # A tab bar is at the bottom, so of everything labelled the same way, take
    # the lowest one on screen.
    matches.sort(key=lambda m: m[3], reverse=True)
    print(f"{matches[0][0]} {matches[0][1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
