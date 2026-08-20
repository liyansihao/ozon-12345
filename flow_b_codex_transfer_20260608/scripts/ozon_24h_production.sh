#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
CONFIG="$ROOT/config/ozon_24h_production.json"
COMMAND="${1:-start}"

export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

case "$COMMAND" in
  supervise)
    exec node "$ROOT/scripts/ozon_24h_supervisor.mjs" supervise "$CONFIG"
    ;;
  probe-browser)
    exec node "$ROOT/scripts/ozon_24h_supervisor.mjs" probe-browser "$CONFIG"
    ;;
  cleanup-profile-caches)
    exec node "$ROOT/scripts/ozon_24h_supervisor.mjs" cleanup-profile-caches "$CONFIG"
    ;;
  start|install|install-candidate|doctor|doctor-candidate|promote|status|stop|resume|export)
    exec node "$ROOT/scripts/ozon_24h_control.mjs" "$COMMAND" "$ROOT" "$CONFIG"
    ;;
  *)
    print -u2 -- "usage: scripts/ozon_24h_production.sh [start|install-candidate|doctor-candidate|promote|doctor|status|stop|resume|export|cleanup-profile-caches]"
    exit 64
    ;;
esac
