# Widget Task 3 Report

## Status

Implemented the macOS desktop quota panel and compact SwiftUI card.

## Changes

- Added `DesktopWidgetPanel`, configured as a transparent, non-activating panel above desktop icons on all Spaces.
- Implemented panel-level mouse event tracking through `sendEvent(_:)` so dragging remains reliable when the hosted SwiftUI view consumes hit-testing.
- Preserved an `onDragEnded` callback that fires after an actual drag with the final panel frame.
- Added a fixed 300 × 150 `DesktopWidgetView` using ultra-thin material and a 16-point continuous corner radius.
- Added loading, available, empty, and failed presentations.
- Reused the existing quota percentage thresholds: green below 80% used, orange from 80%, and red from 95%.
- Added refresh and hide controls that appear only while hovering.
- The view consumes the shared `QuotaStore`; it creates no store, timer, or refresh owner.

## Verification

- `swift build`: passed
- `swift test`: passed (25 tests, 0 failures)

## Concerns

- Dragging begins from any non-button surface. SwiftUI buttons still receive their normal events because the panel observes and then forwards events through `super.sendEvent(_:)`.
- The drag-end callback intentionally fires only when a drag event occurred, not for an ordinary click.

## Review Fix — 2026-07-12

### Findings addressed

- Added a 30-second `TimelineView` update and compact reset countdown beneath each quota ring, including elapsed-reset semantics.
- Replaced panel-wide mouse interception with a dedicated 150 × 28 title drag region. Refresh/hide controls now receive their own complete mouse sequence and cannot move the panel or trigger the placement-save callback.
- Made the header consistently display `Codex 额度` plus state (`更新中…`, `已更新`, `数据可能已过期`, `暂无数据`, or `读取失败`). Removed unbounded limit names from the compact header and reserves trailing space while hover controls are visible.
- Preserved the fixed 300 × 150 outer frame.

### TDD evidence

- RED: `swift test --filter DesktopWidgetPresentationTests` failed because `DesktopWidgetPresentation` did not exist.
- GREEN: the same focused command passed 3 tests covering fresh/stale status, future countdown units, sub-minute countdown, and elapsed reset time.

### Final verification

- `swift build`: passed.
- `swift test`: passed — 28 tests, 0 failures.
- `git diff --check`: passed.

### Remaining concern

- The dedicated title drag target is intentionally limited to the left 150 points of the 28-point header. This makes the interactive boundary explicit and keeps it structurally separate from the top-right controls; it also means dragging must begin from that title area rather than anywhere on the card.
