#!/bin/zsh
set -u

ROOT="${0:A:h:h}"
RUN_DIR="${1:?RUN_DIR is required}"
URLS_FILE="${2:?URLS_FILE is required}"
RESTART_DELAYS=(${(s:,:)${FLOW_B_RESTART_DELAYS_SECONDS:-30,60,120}})
STOP_FILE="$RUN_DIR/.stop"
child_pid=""
restart_index=1
lock_dir="$RUN_DIR/.supervisor.lock"

if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_pid=""
  [[ -s "$lock_dir/pid" ]] && lock_pid=$(<"$lock_dir/pid")
  if [[ "$lock_pid" == <-> ]] && kill -0 "$lock_pid" 2>/dev/null; then
    print -u2 -- "supervisor lock already held by PID $lock_pid"
    exit 73
  fi
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || exit 73
  mkdir "$lock_dir" || exit 73
fi
print -r -- "$$" > "$lock_dir/pid"

release_lock() {
  rm -f "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
}

export FLOW_B_RESUME_WINDOW=1

terminate_child() {
  trap - TERM INT HUP
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  release_lock
  exit 0
}

trap terminate_child TERM INT HUP

while true; do
  if [[ -f "$STOP_FILE" ]]; then
    release_lock
    exit 0
  fi
  node "$ROOT/scripts/flow_b_playwright.mjs" accept "$RUN_DIR" "$URLS_FILE" &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  child_pid=""

  if [[ -f "$STOP_FILE" ]]; then
    exit 0
  fi

  if [[ $exit_code -eq 0 ]]; then
    release_lock
    exit 0
  fi

  ended_at=$(node --input-type=module -e '
    import fs from "node:fs";
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(Date.parse(value.ended_at) || 0));
    } catch {
      process.stdout.write("0");
    }
  ' "$RUN_DIR/acceptance_window.json")
  now_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  if [[ "$ended_at" -gt 0 && "$now_ms" -ge "$ended_at" ]]; then
    release_lock
    exit $exit_code
  fi

  delay_index=$restart_index
  [[ $delay_index -gt ${#RESTART_DELAYS} ]] && delay_index=${#RESTART_DELAYS}
  sleep "${RESTART_DELAYS[$delay_index]}"
  restart_index=$((restart_index + 1))
done
