import XCTest
@testable import CodexQuota

final class WidgetPlacementStoreTests: XCTestCase {
    func testPersistsPlacementAndVisibility() {
        let suite = "WidgetPlacementStoreTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WidgetPlacementStore(defaults: defaults)
        let value = WidgetPlacement(screenID: "screen", x: 0.25, y: 0.75)

        store.save(placement: value)
        store.isVisible = false

        let restored = WidgetPlacementStore(defaults: defaults)
        XCTAssertEqual(restored.placement, value)
        XCTAssertFalse(restored.isVisible)
    }
}
