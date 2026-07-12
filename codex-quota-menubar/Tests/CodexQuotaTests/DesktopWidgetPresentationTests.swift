import XCTest
@testable import CodexQuota

final class DesktopWidgetPresentationTests: XCTestCase {
    func testHeaderStatusDistinguishesFreshAndStaleSnapshots() {
        XCTAssertEqual(DesktopWidgetPresentation.headerStatus(isStale: false), "已更新")
        XCTAssertEqual(DesktopWidgetPresentation.headerStatus(isStale: true), "数据可能已过期")
    }

    func testResetCountdownUsesCompactFutureDurations() {
        let now = Date(timeIntervalSince1970: 1_000)

        XCTAssertEqual(
            DesktopWidgetPresentation.resetCountdown(
                resetsAt: now.addingTimeInterval(2 * 86_400 + 3 * 3_600),
                now: now
            ),
            "2天3小时后重置"
        )
        XCTAssertEqual(
            DesktopWidgetPresentation.resetCountdown(
                resetsAt: now.addingTimeInterval(2 * 3_600 + 7 * 60),
                now: now
            ),
            "2小时7分钟后重置"
        )
        XCTAssertEqual(
            DesktopWidgetPresentation.resetCountdown(
                resetsAt: now.addingTimeInterval(43),
                now: now
            ),
            "不足1分钟后重置"
        )
    }

    func testResetCountdownMarksElapsedResetTime() {
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(
            DesktopWidgetPresentation.resetCountdown(resetsAt: now, now: now),
            "等待额度刷新"
        )
    }
}
