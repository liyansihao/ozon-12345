#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h}"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ozon-control-panel-tests.XXXXXX")"
mkdir -p "$BUILD_ROOT/ModuleCache"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
SWIFTC="$(xcrun --find swiftc)"

cleanup() {
  rm -rf "$BUILD_ROOT"
}
trap cleanup EXIT INT TERM

"$SWIFTC" \
  -parse-as-library \
  -target arm64-apple-macos13.0 \
  -sdk "$SDK_PATH" \
  -module-cache-path "$BUILD_ROOT/ModuleCache" \
  "$PROJECT_ROOT/control-panel/OzonControlCore.swift" \
  "$PROJECT_ROOT/tests-swift/OzonControlCoreTests.swift" \
  -o "$BUILD_ROOT/OzonControlCoreTests"

"$BUILD_ROOT/OzonControlCoreTests"
"$PROJECT_ROOT/scripts/install_ozon_control_panel.sh" "$BUILD_ROOT/Ozon上品控制.app"
/usr/bin/codesign --verify --deep --strict "$BUILD_ROOT/Ozon上品控制.app"
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$BUILD_ROOT/Ozon上品控制.app/Contents/Info.plist"
print -- "PASS app bundle build and ad-hoc signature"

mkdir -p "$BUILD_ROOT/Ozon上品控制.app/Contents"
print -- "original" > "$BUILD_ROOT/Ozon上品控制.app/Contents/recovery-marker.txt"
if OZON_CONTROL_PANEL_TEST_INTERRUPT_AFTER_BACKUP=1 \
  "$PROJECT_ROOT/scripts/install_ozon_control_panel.sh" "$BUILD_ROOT/Ozon上品控制.app"; then
  print -u2 -- "FAIL interrupted install unexpectedly succeeded"
  exit 1
fi
if [[ "$(<"$BUILD_ROOT/Ozon上品控制.app/Contents/recovery-marker.txt")" != "original" ]]; then
  print -u2 -- "FAIL interrupted install did not restore the previous app"
  exit 1
fi
print -- "PASS interrupted install restores previous app"
