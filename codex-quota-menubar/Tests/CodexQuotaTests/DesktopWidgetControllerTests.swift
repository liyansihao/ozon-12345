import XCTest
@testable import CodexQuota

@MainActor
final class DesktopWidgetControllerTests: XCTestCase {
    private let main = WidgetScreen(
        id: "main",
        visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
        isMain: true
    )
    private let external = WidgetScreen(
        id: "external",
        visibleFrame: CGRect(x: 1440, y: 0, width: 1920, height: 1080),
        isMain: false
    )

    func testStartupUsesSameStoreAndPersistedVisibility() {
        let quotaStore = QuotaStore(reader: { nil })
        let placementStore = MemoryPlacementStore(isVisible: true)
        let panel = FakeWidgetPanel()

        let controller = makeController(
            quotaStore: quotaStore,
            placementStore: placementStore,
            screens: { [main] in [main] },
            panel: panel
        )

        XCTAssertTrue(controller.quotaStore === quotaStore)
        XCTAssertTrue(controller.isVisible)
        XCTAssertEqual(panel.showCount, 1)
        XCTAssertEqual(panel.frame, WidgetPlacement.defaultFrame(widgetSize: controller.widgetSize, visibleFrame: main.visibleFrame))
    }

    func testHideShowAndTogglePersistObservableVisibility() {
        let placementStore = MemoryPlacementStore(isVisible: false)
        let panel = FakeWidgetPanel()
        let controller = makeController(placementStore: placementStore, screens: { [main] in [main] }, panel: panel)

        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(panel.hideCount, 1)

        controller.show()
        XCTAssertTrue(controller.isVisible)
        XCTAssertTrue(placementStore.isVisible)
        XCTAssertEqual(panel.showCount, 1)

        controller.toggle()
        XCTAssertFalse(controller.isVisible)
        XCTAssertFalse(placementStore.isVisible)
        XCTAssertEqual(panel.hideCount, 2)
    }

    func testRestoresSavedScreenAndSavesDraggedPlacement() {
        let saved = WidgetPlacement(screenID: external.id, x: 0.25, y: 0.75)
        let placementStore = MemoryPlacementStore(placement: saved, isVisible: true)
        let panel = FakeWidgetPanel()
        let controller = makeController(placementStore: placementStore, screens: { [main, external] in [main, external] }, panel: panel)

        XCTAssertEqual(
            panel.frame,
            saved.restoredFrame(widgetSize: controller.widgetSize, visibleFrame: external.visibleFrame)
        )

        let dragged = CGRect(x: 1800, y: 300, width: 300, height: 150)
        panel.onDragEnded?(dragged)
        XCTAssertEqual(
            placementStore.placement,
            WidgetPlacement.normalized(frame: dragged, visibleFrame: external.visibleFrame, screenID: external.id)
        )
    }

    func testOffscreenDragClampsLivePanelAndPersistsClampedPlacement() {
        let placementStore = MemoryPlacementStore(isVisible: true)
        let panel = FakeWidgetPanel()
        let controller = makeController(placementStore: placementStore, screens: { [main] in [main] }, panel: panel)

        panel.onDragEnded?(CGRect(x: 2_000, y: -500, width: 300, height: 150))

        let expected = CGRect(x: 1_140, y: 0, width: 300, height: 150)
        XCTAssertEqual(panel.frame, expected)
        XCTAssertTrue(main.visibleFrame.contains(panel.frame))
        XCTAssertEqual(
            placementStore.placement,
            WidgetPlacement.normalized(frame: expected, visibleFrame: main.visibleFrame, screenID: main.id)
        )
        withExtendedLifetime(controller) {}
    }

    func testStableScreenIDPrefersDisplayUUIDAndFallsBack() {
        XCTAssertEqual(
            DesktopWidgetController.stableScreenID(displayID: 42, fallback: "42", uuidProvider: { _ in "durable-uuid" }),
            "durable-uuid"
        )
        XCTAssertEqual(
            DesktopWidgetController.stableScreenID(displayID: 42, fallback: "42", uuidProvider: { _ in nil }),
            "42"
        )
    }

    func testPanelCallbacksRefreshSharedStoreAndHideController() async {
        let quotaStore = QuotaStore(reader: { nil })
        let placementStore = MemoryPlacementStore(isVisible: true)
        let panel = FakeWidgetPanel()
        let controller = makeController(
            quotaStore: quotaStore,
            placementStore: placementStore,
            screens: { [main] in [main] },
            panel: panel
        )

        panel.onRefresh?()
        for _ in 0..<100 where quotaStore.state == .loading { await Task.yield() }
        XCTAssertEqual(quotaStore.state, .empty("等待 Codex 新数据"))

        panel.onHide?()
        XCTAssertFalse(controller.isVisible)
        XCTAssertFalse(placementStore.isVisible)
        XCTAssertEqual(panel.hideCount, 1)
    }

    func testMissingScreenFallsBackToMainDefaultAndScreenChangeClamps() {
        let placementStore = MemoryPlacementStore(
            placement: WidgetPlacement(screenID: "disconnected", x: 0.5, y: 0.5),
            isVisible: true
        )
        let panel = FakeWidgetPanel()
        var screens = [main]
        let controller = makeController(placementStore: placementStore, screens: { screens }, panel: panel)

        XCTAssertEqual(panel.frame, WidgetPlacement.defaultFrame(widgetSize: controller.widgetSize, visibleFrame: main.visibleFrame))

        panel.setFrame(CGRect(x: 800, y: 600, width: 300, height: 150))
        screens = [WidgetScreen(id: "main", visibleFrame: CGRect(x: 0, y: 0, width: 1024, height: 700), isMain: true)]
        controller.screenParametersDidChange()
        XCTAssertEqual(panel.frame, CGRect(x: 724, y: 550, width: 300, height: 150))
    }

    func testInvalidSavedCoordinatesFallBackToMainDefault() {
        let placementStore = MemoryPlacementStore(
            placement: WidgetPlacement(screenID: main.id, x: .nan, y: .infinity),
            isVisible: true
        )
        let panel = FakeWidgetPanel()
        let controller = makeController(
            placementStore: placementStore,
            screens: { [main] in [main] },
            panel: panel
        )

        XCTAssertEqual(
            panel.frame,
            WidgetPlacement.defaultFrame(widgetSize: controller.widgetSize, visibleFrame: main.visibleFrame)
        )
    }

    private func makeController(
        quotaStore: QuotaStore? = nil,
        placementStore: MemoryPlacementStore,
        screens: @escaping @MainActor () -> [WidgetScreen],
        panel: FakeWidgetPanel
    ) -> DesktopWidgetController {
        let quotaStore = quotaStore ?? QuotaStore(reader: { nil })
        return DesktopWidgetController(
            quotaStore: quotaStore,
            placementStore: placementStore,
            screens: screens,
            panelFactory: { _, receivedStore, onRefresh, onHide in
                XCTAssertTrue(receivedStore === quotaStore)
                panel.onRefresh = onRefresh
                panel.onHide = onHide
                return panel
            },
            notificationCenter: nil
        )
    }
}

private final class MemoryPlacementStore: WidgetPlacementStoring {
    var placement: WidgetPlacement?
    var isVisible: Bool

    init(placement: WidgetPlacement? = nil, isVisible: Bool) {
        self.placement = placement
        self.isVisible = isVisible
    }

    func save(placement: WidgetPlacement) {
        self.placement = placement
    }
}

@MainActor
private final class FakeWidgetPanel: DesktopWidgetPaneling {
    private(set) var frame: CGRect = .zero
    var onDragEnded: ((CGRect) -> Void)?
    var onRefresh: (() -> Void)?
    var onHide: (() -> Void)?
    private(set) var showCount = 0
    private(set) var hideCount = 0

    func show() { showCount += 1 }
    func hide() { hideCount += 1 }
    func setFrame(_ frame: CGRect) { self.frame = frame }
}
