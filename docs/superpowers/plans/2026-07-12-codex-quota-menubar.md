# Codex 额度菜单栏仪表盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个不消耗 Token、只读取本机 Codex JSONL 数据的原生 macOS 菜单栏额度仪表盘。

**Architecture:** SwiftUI `MenuBarExtra` 只订阅 `QuotaStore` 的可观察状态；文件定位、JSONL 解析、额度领域模型和刷新协调彼此隔离。读取在后台完成，界面始终展示最近一次有效快照，并对缺失、过期和权限错误给出明确状态。

**Tech Stack:** Swift 5.9、SwiftUI、Foundation、Swift Package Manager、XCTest、macOS 13+

## Global Constraints

- 项目目录固定为 `codex-quota-menubar/`，不修改现有 Ozon 自动化代码。
- 最低支持 macOS 13。
- 首个版本不引入第三方依赖，不发起网络请求，也不调用任何 AI/API。
- 只读取 `~/.codex/sessions/**/*.jsonl` 的额度字段，不保存或展示会话正文和认证信息。
- 自动刷新间隔为 60 秒；菜单栏显示两项额度中更低的剩余百分比。
- 首个版本不包含手动校准、通知、登录项、自动更新和 App Store 发布。

---

## File Structure

- `codex-quota-menubar/Package.swift`：Swift 包、可执行目标和测试目标定义。
- `codex-quota-menubar/Sources/CodexQuota/QuotaModels.swift`：额度快照、窗口、读取状态和展示计算。
- `codex-quota-menubar/Sources/CodexQuota/RateLimitParser.swift`：单行及 JSONL 尾部额度解析。
- `codex-quota-menubar/Sources/CodexQuota/CodexSessionLocator.swift`：递归定位最近修改的会话文件。
- `codex-quota-menubar/Sources/CodexQuota/QuotaStore.swift`：后台读取、定时刷新、旧快照保留和错误映射。
- `codex-quota-menubar/Sources/CodexQuota/MenuBarView.swift`：进度、倒计时、空状态和刷新按钮。
- `codex-quota-menubar/Sources/CodexQuota/CodexQuotaApp.swift`：应用入口和菜单栏标题。
- `codex-quota-menubar/scripts/build-app.sh`：构建可双击运行且不显示 Dock 图标的 `.app`。
- `codex-quota-menubar/Tests/CodexQuotaTests/*.swift`：领域模型、解析、文件选择和 Store 测试。
- `codex-quota-menubar/README.md`：构建、运行、隐私和故障说明。

### Task 1: Swift 包与额度领域模型

**Files:**
- Create: `codex-quota-menubar/Package.swift`
- Create: `codex-quota-menubar/Sources/CodexQuota/QuotaModels.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/QuotaModelsTests.swift`

**Interfaces:**
- Produces: `QuotaWindow`, `QuotaSnapshot`, `QuotaLoadState`, `QuotaWindow.displayName`, `QuotaSnapshot.mostConstrainedRemainingPercent`.

- [ ] **Step 1: 创建包清单并写失败测试**

```swift
// Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexQuota",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "CodexQuota", targets: ["CodexQuota"])],
    targets: [
        .executableTarget(name: "CodexQuota"),
        .testTarget(name: "CodexQuotaTests", dependencies: ["CodexQuota"])
    ]
)
```

```swift
// Tests/CodexQuotaTests/QuotaModelsTests.swift
import XCTest
@testable import CodexQuota

final class QuotaModelsTests: XCTestCase {
    func testRemainingPercentIsClamped() {
        XCTAssertEqual(QuotaWindow(usedPercent: 125, windowMinutes: 300, resetsAt: .now).remainingPercent, 0)
        XCTAssertEqual(QuotaWindow(usedPercent: -5, windowMinutes: 300, resetsAt: .now).remainingPercent, 100)
    }

    func testWindowNamesAndMostConstrainedValue() {
        let snapshot = QuotaSnapshot(
            limitID: "codex",
            limitName: "GPT Codex",
            primary: .init(usedPercent: 30, windowMinutes: 300, resetsAt: .now),
            secondary: .init(usedPercent: 55, windowMinutes: 10080, resetsAt: .now),
            observedAt: .now
        )
        XCTAssertEqual(snapshot.primary.displayName, "5 小时额度")
        XCTAssertEqual(snapshot.secondary.displayName, "每周额度")
        XCTAssertEqual(snapshot.mostConstrainedRemainingPercent, 45)
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd codex-quota-menubar && swift test`

Expected: FAIL，提示找不到 `QuotaWindow` 和 `QuotaSnapshot`。

- [ ] **Step 3: 实现最小领域模型**

```swift
// Sources/CodexQuota/QuotaModels.swift
import Foundation

struct QuotaWindow: Equatable, Sendable {
    let usedPercent: Double
    let windowMinutes: Int
    let resetsAt: Date

    var normalizedUsedPercent: Double { min(100, max(0, usedPercent)) }
    var remainingPercent: Double { 100 - normalizedUsedPercent }
    var displayName: String {
        switch windowMinutes {
        case 300: return "5 小时额度"
        case 10080: return "每周额度"
        default: return "\(windowMinutes) 分钟额度"
        }
    }
}

struct QuotaSnapshot: Equatable, Sendable {
    let limitID: String
    let limitName: String
    let primary: QuotaWindow
    let secondary: QuotaWindow
    let observedAt: Date

    var mostConstrainedRemainingPercent: Double {
        min(primary.remainingPercent, secondary.remainingPercent)
    }
}

enum QuotaLoadState: Equatable, Sendable {
    case loading
    case available(QuotaSnapshot, isStale: Bool)
    case empty(String)
    case failed(String)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd codex-quota-menubar && swift test`

Expected: PASS，2 tests，0 failures。

- [ ] **Step 5: 提交领域模型**

```bash
git add codex-quota-menubar/Package.swift codex-quota-menubar/Sources/CodexQuota/QuotaModels.swift codex-quota-menubar/Tests/CodexQuotaTests/QuotaModelsTests.swift
git commit -m "feat: add quota domain model"
```

### Task 2: JSONL 额度解析器

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/RateLimitParser.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/RateLimitParserTests.swift`

**Interfaces:**
- Consumes: `QuotaSnapshot` and `QuotaWindow` from Task 1.
- Produces: `RateLimitParsing.parseLatest(in:observedAt:) -> QuotaSnapshot?` and `RateLimitParser.parseLatest(from:) throws -> QuotaSnapshot?`.

- [ ] **Step 1: 写解析失败测试**

```swift
import XCTest
@testable import CodexQuota

final class RateLimitParserTests: XCTestCase {
    private let valid = #"{"timestamp":"2026-07-12T10:08:16Z","type":"event_msg","payload":{"rate_limits":{"limit_id":"codex_bengalfox","limit_name":"GPT-5.3-Codex-Spark","primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1783868885},"secondary":{"used_percent":41,"window_minutes":10080,"resets_at":1784455685}}}}"#

    func testSelectsLastValidRateLimitAndSkipsMalformedLines() throws {
        let text = "{}\n{broken\n\(valid)\n"
        let snapshot = RateLimitParsing.parseLatest(in: text, observedAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(snapshot?.limitName, "GPT-5.3-Codex-Spark")
        XCTAssertEqual(snapshot?.primary.usedPercent, 12.5)
        XCTAssertEqual(snapshot?.secondary.windowMinutes, 10080)
    }

    func testReturnsNilWithoutCompleteRateLimits() {
        XCTAssertNil(RateLimitParsing.parseLatest(in: "{\"type\":\"event_msg\"}", observedAt: .now))
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd codex-quota-menubar && swift test --filter RateLimitParserTests`

Expected: FAIL，提示找不到 `RateLimitParsing`。

- [ ] **Step 3: 实现解析器**

```swift
import Foundation

private struct Envelope: Decodable {
    struct Payload: Decodable {
        struct Limits: Decodable {
            struct Window: Decodable {
                let usedPercent: Double
                let windowMinutes: Int
                let resetsAt: TimeInterval
                enum CodingKeys: String, CodingKey {
                    case usedPercent = "used_percent", windowMinutes = "window_minutes", resetsAt = "resets_at"
                }
            }
            let limitID: String
            let limitName: String
            let primary: Window
            let secondary: Window
            enum CodingKeys: String, CodingKey {
                case limitID = "limit_id", limitName = "limit_name", primary, secondary
            }
        }
        let rateLimits: Limits?
        enum CodingKeys: String, CodingKey { case rateLimits = "rate_limits" }
    }
    let payload: Payload?
}

enum RateLimitParsing {
    static func parseLatest(in text: String, observedAt: Date) -> QuotaSnapshot? {
        let decoder = JSONDecoder()
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard let data = String(line).data(using: .utf8),
                  let limits = try? decoder.decode(Envelope.self, from: data).payload?.rateLimits else { continue }
            return QuotaSnapshot(
                limitID: limits.limitID,
                limitName: limits.limitName,
                primary: .init(usedPercent: limits.primary.usedPercent, windowMinutes: limits.primary.windowMinutes, resetsAt: Date(timeIntervalSince1970: limits.primary.resetsAt)),
                secondary: .init(usedPercent: limits.secondary.usedPercent, windowMinutes: limits.secondary.windowMinutes, resetsAt: Date(timeIntervalSince1970: limits.secondary.resetsAt)),
                observedAt: observedAt
            )
        }
        return nil
    }
}

struct RateLimitParser: Sendable {
    let maximumBytes = 1_048_576

    func parseLatest(from url: URL) throws -> QuotaSnapshot? {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let size = try handle.seekToEnd()
        let start = size > UInt64(maximumBytes) ? size - UInt64(maximumBytes) : 0
        try handle.seek(toOffset: start)
        let data = try handle.readToEnd() ?? Data()
        let text = String(decoding: data, as: UTF8.self)
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .now
        return RateLimitParsing.parseLatest(in: text, observedAt: modified)
    }
}
```

- [ ] **Step 4: 运行解析测试及全套测试**

Run: `cd codex-quota-menubar && swift test`

Expected: PASS，4 tests，0 failures。

- [ ] **Step 5: 提交解析器**

```bash
git add codex-quota-menubar/Sources/CodexQuota/RateLimitParser.swift codex-quota-menubar/Tests/CodexQuotaTests/RateLimitParserTests.swift
git commit -m "feat: parse Codex rate limits from JSONL"
```

### Task 3: 会话文件定位与最新有效快照读取

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/CodexSessionLocator.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/CodexSessionLocatorTests.swift`

**Interfaces:**
- Consumes: `RateLimitParser.parseLatest(from:)`.
- Produces: `CodexSessionLocating.recentSessionFiles(limit:) throws -> [URL]` and `CodexQuotaReading.readLatest() throws -> QuotaSnapshot?`.

- [ ] **Step 1: 写文件优先级失败测试**

```swift
import XCTest
@testable import CodexQuota

final class CodexSessionLocatorTests: XCTestCase {
    func testReturnsNewestJSONLFirstAndIgnoresOtherFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let old = root.appendingPathComponent("old.jsonl")
        let latest = root.appendingPathComponent("nested/latest.jsonl")
        try FileManager.default.createDirectory(at: latest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: old); try Data().write(to: latest)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: old.path)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 2)], ofItemAtPath: latest.path)

        let files = try CodexSessionLocator(root: root).recentSessionFiles(limit: 10)
        XCTAssertEqual(files.map(\.lastPathComponent), ["latest.jsonl", "old.jsonl"])
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd codex-quota-menubar && swift test --filter CodexSessionLocatorTests`

Expected: FAIL，提示找不到 `CodexSessionLocator`。

- [ ] **Step 3: 实现定位器和读取器**

```swift
import Foundation

protocol CodexSessionLocating: Sendable {
    func recentSessionFiles(limit: Int) throws -> [URL]
}

struct CodexSessionLocator: CodexSessionLocating {
    let root: URL
    init(root: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/sessions")) { self.root = root }

    func recentSessionFiles(limit: Int) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { throw CocoaError(.fileNoSuchFile) }
        let files = enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "jsonl" }
        return try files.sorted {
            let left = try $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast
            let right = try $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast
            return left > right
        }.prefix(limit).map { $0 }
    }
}

struct CodexQuotaReader: Sendable {
    let locator: any CodexSessionLocating
    let parser: RateLimitParser

    init(locator: any CodexSessionLocating = CodexSessionLocator(), parser: RateLimitParser = .init()) {
        self.locator = locator; self.parser = parser
    }

    func readLatest() throws -> QuotaSnapshot? {
        for url in try locator.recentSessionFiles(limit: 30) {
            if let snapshot = try parser.parseLatest(from: url) { return snapshot }
        }
        return nil
    }
}
```

- [ ] **Step 4: 运行全套测试**

Run: `cd codex-quota-menubar && swift test`

Expected: PASS，5 tests，0 failures。

- [ ] **Step 5: 提交文件读取链路**

```bash
git add codex-quota-menubar/Sources/CodexQuota/CodexSessionLocator.swift codex-quota-menubar/Tests/CodexQuotaTests/CodexSessionLocatorTests.swift
git commit -m "feat: locate latest Codex quota snapshot"
```

### Task 4: 可观察 Store、后台刷新与错误降级

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/QuotaStore.swift`
- Create: `codex-quota-menubar/Tests/CodexQuotaTests/QuotaStoreTests.swift`

**Interfaces:**
- Consumes: `QuotaSnapshot`, `QuotaLoadState`, and a `@Sendable () throws -> QuotaSnapshot?` reader closure.
- Produces: `@MainActor final class QuotaStore`, `state`, `refresh()`, `startAutomaticRefresh()`.

- [ ] **Step 1: 写状态降级失败测试**

```swift
import XCTest
@testable import CodexQuota

@MainActor
final class QuotaStoreTests: XCTestCase {
    func testEmptyReaderProducesEmptyState() async {
        let store = QuotaStore(reader: { nil }, refreshInterval: 60)
        await store.refresh()
        XCTAssertEqual(store.state, .empty("等待 Codex 新数据"))
    }

    func testFailureKeepsPreviousSnapshotAsStale() async {
        let snapshot = QuotaSnapshot(limitID: "x", limitName: "Codex", primary: .init(usedPercent: 1, windowMinutes: 300, resetsAt: .now), secondary: .init(usedPercent: 2, windowMinutes: 10080, resetsAt: .now), observedAt: .now)
        var calls = 0
        let store = QuotaStore(reader: {
            calls += 1
            if calls == 1 { return snapshot }
            throw CocoaError(.fileReadNoPermission)
        }, refreshInterval: 60)
        await store.refresh(); await store.refresh()
        XCTAssertEqual(store.state, .available(snapshot, isStale: true))
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd codex-quota-menubar && swift test --filter QuotaStoreTests`

Expected: FAIL，提示找不到 `QuotaStore`。

- [ ] **Step 3: 实现 Store**

```swift
import Foundation

@MainActor
final class QuotaStore: ObservableObject {
    @Published private(set) var state: QuotaLoadState = .loading
    private let reader: @Sendable () throws -> QuotaSnapshot?
    private let refreshInterval: TimeInterval
    private var timerTask: Task<Void, Never>?
    private var lastSnapshot: QuotaSnapshot?

    init(reader: @escaping @Sendable () throws -> QuotaSnapshot? = { try CodexQuotaReader().readLatest() }, refreshInterval: TimeInterval = 60) {
        self.reader = reader
        self.refreshInterval = refreshInterval
    }

    deinit { timerTask?.cancel() }

    func refresh() async {
        do {
            let read = reader
            let result = try await Task.detached(priority: .utility) { try read() }.value
            guard let snapshot = result else {
                state = lastSnapshot.map { .available($0, isStale: true) } ?? .empty("等待 Codex 新数据")
                return
            }
            lastSnapshot = snapshot
            state = .available(snapshot, isStale: false)
        } catch {
            state = lastSnapshot.map { .available($0, isStale: true) } ?? .failed(error.localizedDescription)
        }
    }

    func startAutomaticRefresh() {
        guard timerTask == nil else { return }
        timerTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(self.refreshInterval))
                await self.refresh()
            }
        }
    }
}
```

- [ ] **Step 4: 运行全套测试**

Run: `cd codex-quota-menubar && swift test`

Expected: PASS，7 tests，0 failures。

- [ ] **Step 5: 提交 Store**

```bash
git add codex-quota-menubar/Sources/CodexQuota/QuotaStore.swift codex-quota-menubar/Tests/CodexQuotaTests/QuotaStoreTests.swift
git commit -m "feat: refresh quota state in background"
```

### Task 5: SwiftUI 菜单栏界面

**Files:**
- Create: `codex-quota-menubar/Sources/CodexQuota/MenuBarView.swift`
- Create: `codex-quota-menubar/Sources/CodexQuota/CodexQuotaApp.swift`

**Interfaces:**
- Consumes: `QuotaStore.state`, `QuotaStore.refresh()`, and `QuotaStore.startAutomaticRefresh()`.
- Produces: runnable `CodexQuota` executable with menu bar percentage and detail panel.

- [ ] **Step 1: 实现额度卡片和面板**

```swift
import SwiftUI

struct QuotaCard: View {
    let window: QuotaWindow
    private var color: Color {
        window.normalizedUsedPercent >= 95 ? .red : window.normalizedUsedPercent >= 80 ? .orange : .green
    }

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle().stroke(color.opacity(0.18), lineWidth: 7)
                Circle().trim(from: 0, to: window.remainingPercent / 100).stroke(color, style: .init(lineWidth: 7, lineCap: .round)).rotationEffect(.degrees(-90))
                Text("\(Int(window.remainingPercent.rounded()))% ").font(.headline.monospacedDigit())
            }.frame(width: 70, height: 70)
            VStack(alignment: .leading, spacing: 5) {
                Text(window.displayName).font(.headline)
                Text("已用 \(Int(window.normalizedUsedPercent.rounded()))% · 剩余 \(Int(window.remainingPercent.rounded()))%")
                    .font(.caption).foregroundStyle(.secondary)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(resetText(at: context.date)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func resetText(at now: Date) -> String {
        guard window.resetsAt > now else { return "等待额度刷新" }
        let formatter = RelativeDateTimeFormatter(); formatter.unitsStyle = .full
        return "重置时间：\(formatter.localizedString(for: window.resetsAt, relativeTo: now))"
    }
}

struct MenuBarView: View {
    @ObservedObject var store: QuotaStore
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch store.state {
            case .loading: ProgressView("读取本机 Codex 额度…")
            case let .available(snapshot, isStale):
                HStack { Text(snapshot.limitName).font(.headline); Spacer(); if isStale { Text("数据可能已过期").font(.caption).foregroundStyle(.orange) } }
                QuotaCard(window: snapshot.primary)
                Divider()
                QuotaCard(window: snapshot.secondary)
                Text("更新于 \(snapshot.observedAt.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(.tertiary)
            case let .empty(message): ContentUnavailableView(message, systemImage: "gauge.with.dots.needle.0percent", description: Text("请先在 Codex 中运行一次任务"))
            case let .failed(message): ContentUnavailableView("无法读取额度", systemImage: "exclamationmark.triangle", description: Text(message))
            }
            Divider()
            HStack {
                Button("刷新") { Task { await store.refresh() } }.keyboardShortcut("r")
                Spacer()
                Button("退出") { NSApplication.shared.terminate(nil) }
            }
        }.padding(16).frame(width: 330).task { store.startAutomaticRefresh() }
    }
}
```

- [ ] **Step 2: 实现应用入口和菜单栏标题**

```swift
import SwiftUI

@main
struct CodexQuotaApp: App {
    @StateObject private var store = QuotaStore()

    var body: some Scene {
        MenuBarExtra { MenuBarView(store: store) } label: {
            switch store.state {
            case let .available(snapshot, _):
                Label("\(Int(snapshot.mostConstrainedRemainingPercent.rounded()))%", systemImage: "gauge.with.dots.needle.50percent")
            default:
                Label("Codex", systemImage: "gauge.with.dots.needle.0percent")
            }
        }
        .menuBarExtraStyle(.window)
    }
}
```

- [ ] **Step 3: 构建并运行手动验证**

Run: `cd codex-quota-menubar && swift build && swift run CodexQuota`

Expected: 菜单栏出现 Codex 图标和真实剩余百分比；点击后显示两项额度、重置倒计时和更新时间；终端无崩溃日志。验证后按菜单中的“退出”。

- [ ] **Step 4: 运行测试并提交 UI**

Run: `cd codex-quota-menubar && swift test`

Expected: PASS，7 tests，0 failures。

```bash
git add codex-quota-menubar/Sources/CodexQuota/MenuBarView.swift codex-quota-menubar/Sources/CodexQuota/CodexQuotaApp.swift
git commit -m "feat: add Codex quota menu bar interface"
```

### Task 6: `.app` 打包、隐私说明与最终验证

**Files:**
- Create: `codex-quota-menubar/scripts/build-app.sh`
- Create: `codex-quota-menubar/README.md`

**Interfaces:**
- Consumes: SwiftPM executable product `CodexQuota`.
- Produces: `codex-quota-menubar/dist/Codex Quota.app` with `LSUIElement=true`.

- [ ] **Step 1: 添加可执行打包脚本**

```bash
#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
cd "$ROOT"
swift build -c release
APP="$ROOT/dist/Codex Quota.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/.build/release/CodexQuota" "$APP/Contents/MacOS/CodexQuota"
touch "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Clear dict' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string Codex Quota' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Codex Quota' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.lihuohuo.codexquota' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string CodexQuota' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 13.0' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
echo "$APP"
```

Run: `chmod +x codex-quota-menubar/scripts/build-app.sh && codex-quota-menubar/scripts/build-app.sh`

Expected: 输出绝对 `.app` 路径，`codesign` 成功。

- [ ] **Step 2: 添加 README**

```markdown
# Codex Quota

原生 macOS 菜单栏额度仪表盘，显示本机 Codex 的 5 小时与每周额度。

## 构建与运行

要求 macOS 13+ 和 Xcode Command Line Tools。

```bash
./scripts/build-app.sh
open "dist/Codex Quota.app"
```

## 数据与隐私

应用只在本机读取 `~/.codex/sessions/**/*.jsonl` 中的 `rate_limits` 字段，不调用模型、不消耗 Token、不请求网络，也不读取认证令牌。

## 没有数据显示

先在 Codex 中完成一次任务，等待任务生成新的额度记录，然后点击仪表盘中的“刷新”。
```

- [ ] **Step 3: 执行自动验证**

Run: `cd codex-quota-menubar && swift test && ./scripts/build-app.sh && plutil -p "dist/Codex Quota.app/Contents/Info.plist" | rg 'LSUIElement|CFBundleIdentifier'`

Expected: 所有测试通过；输出包含 `"LSUIElement" => true` 和 `"CFBundleIdentifier" => "com.lihuohuo.codexquota"`。

- [ ] **Step 4: 执行桌面验收**

Run: `open "codex-quota-menubar/dist/Codex Quota.app"`

Expected: 应用只出现在菜单栏、不出现在 Dock；显示本机真实额度；点击刷新可更新；活动监视器中无持续高 CPU。随后将 `~/.codex/sessions` 临时改名、点击刷新，确认显示旧数据并标记过期，再立即恢复目录名称。

- [ ] **Step 5: 提交打包与说明**

```bash
git add codex-quota-menubar/scripts/build-app.sh codex-quota-menubar/README.md
git commit -m "build: package Codex quota menu bar app"
```

- [ ] **Step 6: 最终工作区核对**

Run: `git status --short && git log --oneline -6`

Expected: 只保留用户在任务开始前已有的非本功能改动；日志包含本计划产生的六个功能提交，不包含 `dist/` 或 `.build/` 产物提交。
