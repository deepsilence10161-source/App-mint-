#!/usr/bin/env python3
"""
Read a uiautomator XML dump on stdin and print "x y", the centre of an ANR
dialog's dismiss button (by resource-id android:id/aerr_wait, or by text).

Used by run.sh's dismiss_anr helper. ANR dialogs would otherwise sit on top of
the app and every subsequent screenshot would show the dialog instead of the app,
which is how a broken run can accidentally look like a passing one.
"""
import re
import sys

xml = sys.stdin.read()
for node in re.findall(r"<node [^>]*>", xml):
    if ('resource-id="android:id/aerr_wait"' in node
            or 'text="Wait"' in node
            or 'text="OK"' in node):
        m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
