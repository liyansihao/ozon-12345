import XCTest
@testable import CodexQuota

final class RateLimitParserTests: XCTestCase {
    private let valid = #"{"timestamp":"2026-07-12T10:08:16Z","type":"event_msg","payload":{"rate_limits":{"limit_id":"codex_bengalfox","limit_name":"GPT-5.3-Codex-Spark","primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1783868885},"secondary":{"used_percent":41,"window_minutes":10080,"resets_at":1784455685}}}}"#
    private let laterValid = #"{"timestamp":"2026-07-12T10:09:16Z","type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","limit_name":"Later","primary":{"used_percent":72,"window_minutes":300,"resets_at":1783869999},"secondary":{"used_percent":84,"window_minutes":10080,"resets_at":1784459999}}}}"#

    func testSelectsLastValidRateLimitAndSkipsMalformedLines() throws {
        let text = "{}\n\(valid)\n{broken\n\(laterValid)\n"
        let snapshot = RateLimitParsing.parseLatest(in: text, observedAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(snapshot?.limitName, "Later")
        XCTAssertEqual(snapshot?.primary.usedPercent, 72)
        XCTAssertEqual(snapshot?.secondary.windowMinutes, 10080)
    }

    func testReturnsNilWithoutCompleteRateLimits() {
        XCTAssertNil(RateLimitParsing.parseLatest(in: "{\"type\":\"event_msg\"}", observedAt: .now))
    }

    func testTailReadSkipsPartialFirstLineWhenFileExceedsMaximumBytes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("large.jsonl")
        let prefix = String(repeating: "x", count: 1_048_576 + 100)
        try (prefix + "\n" + valid + "\n").write(to: file, atomically: true, encoding: .utf8)

        let snapshot = try RateLimitParser().parseLatest(from: file)

        XCTAssertEqual(snapshot?.limitName, "GPT-5.3-Codex-Spark")
    }
}
