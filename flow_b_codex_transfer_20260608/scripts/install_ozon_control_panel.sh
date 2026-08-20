#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h}"
SOURCE_DIR="$PROJECT_ROOT/control-panel"
APP_NAME="Ozon上品控制.app"
DESTINATION="${1:-${HOME}/Desktop/${APP_NAME}}"

if [[ "$(uname -m)" != "arm64" ]]; then
  print -u2 -- "当前安装器只支持 Apple Silicon Mac。"
  exit 64
fi

if [[ "${DESTINATION:t}" != *.app || "$DESTINATION" == "/" ]]; then
  print -u2 -- "安装目标必须是明确的 .app 路径。"
  exit 64
fi

for required in OzonControlCore.swift OzonControlPanel.swift Info.plist; do
  if [[ ! -f "$SOURCE_DIR/$required" ]]; then
    print -u2 -- "缺少控制面板源文件：$SOURCE_DIR/$required"
    exit 66
  fi
done

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ozon-control-panel.XXXXXX")"
NEW_APP="$BUILD_ROOT/$APP_NAME"
BACKUP_APP="${DESTINATION}.previous-${$}"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
SWIFTC="$(xcrun --find swiftc)"

cleanup() {
  local exit_code=$?
  if [[ ! -e "$DESTINATION" && -e "$BACKUP_APP" ]]; then
    mv "$BACKUP_APP" "$DESTINATION" || true
  fi
  rm -rf "$BUILD_ROOT" || true
  return "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$NEW_APP/Contents/MacOS" "${DESTINATION:h}" "$BUILD_ROOT/ModuleCache"
cp "$SOURCE_DIR/Info.plist" "$NEW_APP/Contents/Info.plist"

"$SWIFTC" \
  -parse-as-library \
  -O \
  -target arm64-apple-macos13.0 \
  -sdk "$SDK_PATH" \
  -module-cache-path "$BUILD_ROOT/ModuleCache" \
  -framework AppKit \
  -framework Combine \
  -framework SwiftUI \
  "$SOURCE_DIR/OzonControlCore.swift" \
  "$SOURCE_DIR/OzonControlPanel.swift" \
  -o "$NEW_APP/Contents/MacOS/OzonControlPanel"

chmod 755 "$NEW_APP/Contents/MacOS/OzonControlPanel"
/usr/bin/plutil -lint "$NEW_APP/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - --timestamp=none "$NEW_APP"
/usr/bin/codesign --verify --deep --strict "$NEW_APP"

if [[ -e "$BACKUP_APP" ]]; then
  print -u2 -- "临时备份目标已存在：$BACKUP_APP"
  exit 73
fi

if [[ -e "$DESTINATION" ]]; then
  mv "$DESTINATION" "$BACKUP_APP"
fi

if [[ "${OZON_CONTROL_PANEL_TEST_INTERRUPT_AFTER_BACKUP:-0}" == "1" ]]; then
  kill -TERM "${$}"
fi

if ! mv "$NEW_APP" "$DESTINATION"; then
  if [[ -e "$BACKUP_APP" ]]; then
    mv "$BACKUP_APP" "$DESTINATION"
  fi
  exit 74
fi

if [[ -e "$BACKUP_APP" ]]; then
  rm -rf "$BACKUP_APP"
fi

print -- "已安装：$DESTINATION"
print -- "控制脚本：${HOME}/.ozon-24h-production/app/scripts/ozon_24h_production.sh"
