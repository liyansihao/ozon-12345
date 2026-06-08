#!/usr/bin/env python3
"""Run JavaScript in the first Chrome tab whose URL contains a substring."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: flow_b_chrome_js_tab.py URL_SUBSTRING JS_FILE", file=sys.stderr)
        return 2

    url_substring = sys.argv[1]
    js_path = Path(sys.argv[2]).expanduser().resolve()
    script = """
on run argv
  set url_part to item 1 of argv
  set js_code to read POSIX file (item 2 of argv)
  tell application "Google Chrome"
    repeat with w in windows
      repeat with i from 1 to count of tabs of w
        set t to tab i of w
        if (URL of t contains url_part) then
          set active tab index of w to i
          set index of w to 1
          tell t to set js_result to execute javascript js_code
          return js_result
        end if
      end repeat
    end repeat
  end tell
  error "No Chrome tab contains: " & url_part
end run
"""
    proc = subprocess.run(
        ["osascript", "-", url_substring, str(js_path)],
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
