import XCTest
@testable import CodexQuota

final class WidgetPlacementTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let size = CGSize(width: 300, height: 150)

    func testDefaultFrameUsesTopRightMargin() {
        XCTAssertEqual(
            WidgetPlacement.defaultFrame(widgetSize: size, visibleFrame: screen),
            CGRect(x: 1120, y: 730, width: 300, height: 150)
        )
    }

    func testNormalizeRestoreAndClamp() {
        let frame = CGRect(x: 570, y: 375, width: 300, height: 150)
        let placement = WidgetPlacement.normalized(frame: frame, visibleFrame: screen, screenID: "main")
        XCTAssertEqual(placement.x, 0.5, accuracy: 0.001)
        XCTAssertEqual(placement.y, 0.5, accuracy: 0.001)
        XCTAssertEqual(placement.restoredFrame(widgetSize: size, visibleFrame: screen), frame)
        XCTAssertEqual(
            WidgetPlacement.clamped(
                frame: CGRect(x: -50, y: 880, width: 300, height: 150),
                visibleFrame: screen
            ),
            CGRect(x: 0, y: 750, width: 300, height: 150)
        )
    }
}
