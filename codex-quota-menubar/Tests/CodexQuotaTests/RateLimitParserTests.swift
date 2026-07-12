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
