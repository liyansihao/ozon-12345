# Desktop Widget Task 4 Report

## Status

Implemented Task 4 only: desktop widget controller, app lifecycle ownership, shared quota store integration, and menu-bar visibility control.

## Implementation

- Added an observable `DesktopWidgetController` with `show`, `hide`, and `toggle` behavior.
- Injected screen discovery and panel creation so controller behavior is unit-testable without opening real AppKit windows.
- Restores normalized placement on the saved screen, falls back to the main screen when the saved screen is unavailable or placement data is invalid, and clamps frames after display changes.
- Persists visibility and drag-end placement.
- Added `CodexQuotaAppModel`, retained outside the SwiftUI body, which owns exactly one `QuotaStore`, one `AutomaticRefreshOwner`, and one controller.
- Injected the same `QuotaStore` into both menu-bar and desktop views.
- Added a menu button whose label tracks observable widget visibility.

## TDD Evidence

1. Added `DesktopWidgetControllerTests` before the implementation and confirmed compilation failed because the controller interfaces did not exist.
2. Added invalid-coordinate coverage and confirmed it failed with a `NaN` frame before implementing the fallback.
3. Final full suite: `swift test` — 33 tests passed, 0 failures.
4. Release verification: `swift build -c release` — succeeded.

## Scope and Concerns

- No Flow B files were modified by this task.
- Existing unrelated dirty worktree files were left untouched and excluded from the commit.
- Real multi-monitor disconnect and fullscreen/Space behavior remain manual desktop acceptance items in Task 5; controller recovery behavior is covered with injected screen fixtures here.

## Blocking Review Fixes (2026-07-12)

- Drag completion now selects the target display, clamps the frame to that display's visible frame, applies the clamped frame to the live panel, and only then persists its normalized placement.
- Production screen identity now uses the durable ColorSync display UUID returned by `CGDisplayCreateUUIDFromDisplayID`; the display number/string remains a fallback only when UUID lookup is unavailable. Injected `WidgetScreen` fixtures remain unchanged.
- Added coverage for a fully offscreen drag (both live frame and persisted placement), UUID preference/fallback, and panel callbacks reaching the shared `QuotaStore` and widget controller.
- Preserved the existing single `QuotaStore` / single automatic-refresh owner architecture and the macOS 13 deployment target.
- Verification: `swift test` — 36 tests passed, 0 failures; `swift build -c release` — succeeded.
- Flow B files and all other unrelated worktree changes were left untouched.
