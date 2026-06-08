#!/usr/bin/env python3
"""Run JavaScript in the active Google Chrome tab via AppleScript."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: flow_b_chrome_js.py JS_FILE", file=sys.stderr)
        return 2
    js_path = Path(sys.argv[1]).expanduser().resolve()
    script = """
on run argv
  set js_code to read POSIX file (item 1 of argv)
  tell application "Google Chrome"
    tell active tab of front window
      execute javascript js_code
    end tell
  end tell
end run
"""
    proc = subprocess.run(
        ["osascript", "-", str(js_path)],
        input=script,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
