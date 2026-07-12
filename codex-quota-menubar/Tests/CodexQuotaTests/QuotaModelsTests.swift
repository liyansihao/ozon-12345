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
