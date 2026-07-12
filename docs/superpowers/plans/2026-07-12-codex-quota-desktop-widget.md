# Codex 额度桌面悬浮卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Codex Quota 菜单栏应用中增加可拖动、记忆位置、只停留在桌面层的额度卡片。

**Architecture:** `CodexQuotaApp` 继续持有唯一 `QuotaStore`，并通过应用生命周期对象创建 `DesktopWidgetController`。控制器管理一个承载 SwiftUI 内容的无边框 `NSPanel`；纯值类型 `WidgetPlacement` 负责坐标换算，`WidgetPlacementStore` 只负责 UserDefaults 持久化。

**Tech Stack:** Swift 5.9、SwiftUI、AppKit、Foundation、Swift Package Manager、XCTest、macOS 13+

## Global Constraints

- 只扩展 `codex-quota-menubar/`，不修改 Ozon 自动化代码。
- 最低支持 macOS 13，不增加第三方依赖。
- 菜单栏与桌面卡片必须共享同一个 `QuotaStore` 和同一个 60 秒刷新循环。
- 不发起网络请求、不调用模型、不消耗 Token。
- 卡片不显示在 Dock 或 Command-Tab，不覆盖普通应用及全屏应用。
- 卡片可拖动，并持久化显示状态、屏幕标识和归一化位置。
- 屏幕消失或位置无效时，回退到主屏幕右上角并保持完整可见。

---

## File Structure

- `Sources/CodexQuota/WidgetPlacement.swift`：纯坐标模型、归一化、恢复和可见区域限制。
- `Sources/CodexQuota/WidgetPlacementStore.swift`：UserDefaults 编解码与显示状态。
- `Sources/CodexQuota/DesktopWidgetPanel.swift`：桌面层 NSPanel 配置和拖动回调。
- `Sources/CodexQuota/DesktopWidgetView.swift`：紧凑额度卡片 UI。
- `Sources/CodexQuota/DesktopWidgetController.swift`：窗口生命周期、显示隐藏、屏幕变化与位置保存。
- `Sources/CodexQuota/CodexQuotaApp.swift`：创建并保留共享 Store 与控制器。
- `Sources/CodexQuota/MenuBarView.swift`：增加显示/隐藏桌面卡片入口。
- `Tests/CodexQuotaTests/WidgetPlacementTests.swift`：坐标规则测试。
- `Tests/CodexQuotaTests/WidgetPlacementStoreTests.swift`：持久化测试。
- `Tests/CodexQuotaTests/DesktopWidgetControllerTests.swift`：共享 Store、显示状态和恢复行为测试。
- `README.md`：桌面卡片使用说明。

### Task 1: 纯位置模型

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/WidgetPlacement.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/WidgetPlacementTests.swift`

**Interfaces:**
- Produces: `WidgetPlacement`, `WidgetPlacement.defaultFrame(widgetSize:visibleFrame:)`, `normalized(frame:visibleFrame:)`, `restoredFrame(widgetSize:visibleFrame:)`, `clamped(frame:visibleFrame:)`.

- [ ] **Step 1: 写失败测试**

```swift
import XCTest
@testable import CodexQuota

final class WidgetPlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let size = CGSize(width: 300, height: 150)

    func testDefaultFrameUsesTopRightMargin() {
        XCTAssertEqual(WidgetPlacement.defaultFrame(widgetSize: size, visibleFrame: screen), CGRect(x: 1120, y: 730, width: 300, height: 150))
    }

    func testNormalizeRestoreAndClamp() {
        let frame = CGRect(x: 570, y: 375, width: 300, height: 150)
        let placement = WidgetPlacement.normalized(frame: frame, visibleFrame: screen, screenID: "main")
        XCTAssertEqual(placement.x, 0.5, accuracy: 0.001)
        XCTAssertEqual(placement.y, 0.5, accuracy: 0.001)
        XCTAssertEqual(placement.restoredFrame(widgetSize: size, visibleFrame: screen), frame)
        XCTAssertEqual(WidgetPlacement.clamped(frame: CGRect(x: -50, y: 880, width: 300, height: 150), visibleFrame: screen), CGRect(x: 0, y: 750, width: 300, height: 150))
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd codex-quota-menubar && swift test --filter WidgetPlacementTests`

Expected: FAIL，找不到 `WidgetPlacement`。

- [ ] **Step 3: 实现位置模型**

```swift
import Foundation

struct WidgetPlacement: Codable, Equatable, Sendable {
    let screenID: String
    let x: Double
    let y: Double
    static let margin: CGFloat = 20

    static func defaultFrame(widgetSize: CGSize, visibleFrame: CGRect) -> CGRect {
        CGRect(x: visibleFrame.maxX - widgetSize.width - margin, y: visibleFrame.maxY - widgetSize.height - margin, width: widgetSize.width, height: widgetSize.height)
    }

    static func normalized(frame: CGRect, visibleFrame: CGRect, screenID: String) -> WidgetPlacement {
        let availableX = max(1, visibleFrame.width - frame.width)
        let availableY = max(1, visibleFrame.height - frame.height)
        return WidgetPlacement(screenID: screenID, x: (frame.minX - visibleFrame.minX) / availableX, y: (frame.minY - visibleFrame.minY) / availableY)
    }

    func restoredFrame(widgetSize: CGSize, visibleFrame: CGRect) -> CGRect {
        let frame = CGRect(x: visibleFrame.minX + x * max(0, visibleFrame.width - widgetSize.width), y: visibleFrame.minY + y * max(0, visibleFrame.height - widgetSize.height), width: widgetSize.width, height: widgetSize.height)
        return Self.clamped(frame: frame, visibleFrame: visibleFrame)
    }

    static func clamped(frame: CGRect, visibleFrame: CGRect) -> CGRect {
        var result = frame
        result.origin.x = min(max(result.minX, visibleFrame.minX), max(visibleFrame.minX, visibleFrame.maxX - result.width))
        result.origin.y = min(max(result.minY, visibleFrame.minY), max(visibleFrame.minY, visibleFrame.maxY - result.height))
        return result
    }
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `cd codex-quota-menubar && swift test`

Expected: 所有测试通过。

```bash
git add codex-quota-menubar/Sources/CodexQuota/WidgetPlacement.swift codex-quota-menubar/Tests/CodexQuotaTests/WidgetPlacementTests.swift
git commit -m "feat: add desktop widget placement model"
```

### Task 2: 位置与显示状态持久化

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/WidgetPlacementStore.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/WidgetPlacementStoreTests.swift`

**Interfaces:**
- Consumes: `WidgetPlacement`.
- Produces: `WidgetPlacementStoring`, `WidgetPlacementStore.placement`, `isVisible`, `save(placement:)`.

- [ ] **Step 1: 写 UserDefaults 隔离测试**

```swift
import XCTest
@testable import CodexQuota

final class WidgetPlacementStoreTests: XCTestCase {
    func testPersistsPlacementAndVisibility() {
        let suite = "WidgetPlacementStoreTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPlacementStore(defaults: defaults)
        let value = WidgetPlacement(screenID: "screen", x: 0.25, y: 0.75)
        store.save(placement: value); store.isVisible = false
        let restored = WidgetPlacementStore(defaults: defaults)
        XCTAssertEqual(restored.placement, value)
        XCTAssertFalse(restored.isVisible)
    }
}
```

- [ ] **Step 2: 运行失败测试**

Run: `cd codex-quota-menubar && swift test --filter WidgetPlacementStoreTests`

Expected: FAIL，找不到 `WidgetPlacementStore`。

- [ ] **Step 3: 实现持久化**

```swift
import Foundation

protocol WidgetPlacementStoring: AnyObject {
    var placement: WidgetPlacement? { get }
    var isVisible: Bool { get set }
    func save(placement: WidgetPlacement)
}

final class WidgetPlacementStore: WidgetPlacementStoring {
    private let defaults: UserDefaults
    private let placementKey = "desktopWidget.placement"
    private let visibilityKey = "desktopWidget.isVisible"
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var placement: WidgetPlacement? { defaults.data(forKey: placementKey).flatMap { try? JSONDecoder().decode(WidgetPlacement.self, from: $0) } }
    var isVisible: Bool {
        get { defaults.object(forKey: visibilityKey) == nil ? true : defaults.bool(forKey: visibilityKey) }
        set { defaults.set(newValue, forKey: visibilityKey) }
    }
    func save(placement: WidgetPlacement) { defaults.set(try? JSONEncoder().encode(placement), forKey: placementKey) }
}
```

- [ ] **Step 4: 运行全套测试并提交**

Run: `cd codex-quota-menubar && swift test`

Expected: 所有测试通过。

```bash
git add codex-quota-menubar/Sources/CodexQuota/WidgetPlacementStore.swift codex-quota-menubar/Tests/CodexQuotaTests/WidgetPlacementStoreTests.swift
git commit -m "feat: persist desktop widget placement"
```

### Task 3: 桌面 Panel 与 SwiftUI 卡片

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/DesktopWidgetPanel.swift`
- Create: `codex-quota-menubar/Sources/CodexQuota/DesktopWidgetView.swift`

**Interfaces:**
- Consumes: `QuotaStore` and `QuotaLoadState`.
- Produces: `DesktopWidgetPanel`, `DesktopWidgetView`, drag-end callback.

- [ ] **Step 1: 实现桌面窗口**

```swift
import AppKit

final class DesktopWidgetPanel: NSPanel {
    var onDragEnded: ((NSRect) -> Void)?
    private var dragOrigin: NSPoint?

    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false; backgroundColor = .clear; hasShadow = true
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        hidesOnDeactivate = false; isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func mouseDown(with event: NSEvent) { dragOrigin = event.locationInWindow }
    override func mouseDragged(with event: NSEvent) {
        guard let dragOrigin else { return }
        let current = event.locationInWindow
        setFrameOrigin(NSPoint(x: frame.origin.x + current.x - dragOrigin.x, y: frame.origin.y + current.y - dragOrigin.y))
    }
    override func mouseUp(with event: NSEvent) { dragOrigin = nil; onDragEnded?(frame) }
}
```

- [ ] **Step 2: 实现卡片视图**

创建 `DesktopWidgetView`，宽 300、高 150，使用 `.ultraThinMaterial`、16 点圆角。复用 `QuotaWindow` 的百分比和颜色规则；正常状态并列显示两个紧凑进度环，空状态和失败状态显示简短文案。通过 `onRefresh` 与 `onHide` 闭包调用控制器，不在视图中创建 Store 或定时器。操作按钮仅在 `onHover` 为真时显示。

- [ ] **Step 3: 构建并提交**

Run: `cd codex-quota-menubar && swift build && swift test`

Expected: 构建与现有测试全部通过。

```bash
git add codex-quota-menubar/Sources/CodexQuota/DesktopWidgetPanel.swift codex-quota-menubar/Sources/CodexQuota/DesktopWidgetView.swift
git commit -m "feat: add desktop quota widget panel"
```

### Task 4: 控制器、共享 Store 与菜单栏入口

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/DesktopWidgetController.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/DesktopWidgetControllerTests.swift`
- Modify: `codex-quota-menubar/Sources/CodexQuota/CodexQuotaApp.swift`
- Modify: `codex-quota-menubar/Sources/CodexQuota/MenuBarView.swift`

**Interfaces:**
- Consumes: `QuotaStore`, `WidgetPlacementStoring`, `DesktopWidgetPanel`.
- Produces: `DesktopWidgetControlling.show()`, `hide()`, `toggle()`, `isVisible`, screen-change recovery.

- [ ] **Step 1: 写控制器行为测试**

使用协议化的窗口工厂、屏幕提供者和内存 `WidgetPlacementStoring`，验证：启动时根据 `isVisible` 显示；隐藏写回状态；恢复时选择保存的屏幕；屏幕不存在时使用主屏默认位置；控制器持有传入的同一个 `QuotaStore`，不创建刷新循环。

- [ ] **Step 2: 实现控制器**

控制器在主线程创建 `NSHostingView(rootView: DesktopWidgetView(...))` 并赋给 Panel。监听 `NSApplication.didChangeScreenParametersNotification`，变化后把窗口限制到有效屏幕。拖动结束时根据窗口中心确定所在屏幕并保存归一化位置。`show()` 调用 `orderFrontRegardless()`，`hide()` 调用 `orderOut(nil)`，两者同步保存 `isVisible`。

- [ ] **Step 3: 接入应用生命周期**

在 `CodexQuotaApp` 中由一个 `@StateObject` 应用模型同时持有唯一 `QuotaStore`、`AutomaticRefreshOwner` 和 `DesktopWidgetController`。应用模型初始化时启动刷新并根据保存状态显示卡片。不要在 SwiftUI `body` 反复创建控制器。

- [ ] **Step 4: 增加菜单栏开关**

给 `MenuBarView` 注入 `DesktopWidgetControlling`，在底部按钮区增加“显示桌面卡片”或“隐藏桌面卡片”。状态变化通过控制器的可观察 `isVisible` 更新文案。

- [ ] **Step 5: 测试、构建并提交**

Run: `cd codex-quota-menubar && swift test && swift build -c release`

Expected: 全部测试通过且 Release 构建成功。

```bash
git add codex-quota-menubar/Sources/CodexQuota/DesktopWidgetController.swift codex-quota-menubar/Sources/CodexQuota/CodexQuotaApp.swift codex-quota-menubar/Sources/CodexQuota/MenuBarView.swift codex-quota-menubar/Tests/CodexQuotaTests/DesktopWidgetControllerTests.swift
git commit -m "feat: integrate desktop quota widget"
```

### Task 5: 使用说明与桌面验收

**Files:**
- Modify: `codex-quota-menubar/README.md`

**Interfaces:**
- Produces: packaged `.app` with menu bar and desktop widget.

- [ ] **Step 1: 更新 README**

说明启动后桌面右上角会出现卡片；卡片可拖动并记住位置；鼠标移入可刷新或隐藏；菜单栏可恢复；普通窗口会盖住卡片；全部功能仍只读取本机数据且不消耗 Token。

- [ ] **Step 2: 执行自动验证**

Run: `cd codex-quota-menubar && swift test && ./scripts/build-app.sh && plutil -lint "dist/Codex Quota.app/Contents/Info.plist" && codesign --verify --deep --strict "dist/Codex Quota.app"`

Expected: 测试全绿，应用打包、plist 和签名验证全部成功。

- [ ] **Step 3: 执行真实桌面验收**

启动打包应用并依次验证：桌面右上角默认显示；拖动并重启后位置恢复；普通窗口盖住卡片；回到桌面卡片可见；隐藏和菜单栏恢复成功；切换 Space 和全屏应用时不覆盖全屏。若当前只有单屏，使用显示器分辨率切换验证卡片仍在可见区域，并把外接屏拔插列为未执行项。

- [ ] **Step 4: 提交说明**

```bash
git add codex-quota-menubar/README.md
git commit -m "docs: explain desktop quota widget"
```

- [ ] **Step 5: 最终核对**

Run: `git status --short && git log --oneline -5`

Expected: 功能文件均已提交；`.build/` 和 `dist/` 仍被忽略；用户原有 Ozon 工作区改动保持不变。
