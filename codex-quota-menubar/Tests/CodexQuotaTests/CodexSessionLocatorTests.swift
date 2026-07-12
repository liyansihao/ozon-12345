import Foundation
import XCTest
@testable import CodexQuota

final class CodexSessionLocatorTests: XCTestCase {
    private final class RecordingLocator: CodexSessionLocating, @unchecked Sendable {
        private let lock = NSLock()
        private let files: [URL]
        private var recordedLimits: [Int] = []

        init(files: [URL]) {
            self.files = files
        }

        func recentSessionFiles(limit: Int) throws -> [URL] {
            lock.lock()
            recordedLimits.append(limit)
            lock.unlock()
            return files
        }

        var limits: [Int] {
            lock.lock()
            defer { lock.unlock() }
            return recordedLimits
        }
    }

    private let validSnapshotLine = #"{"timestamp":"2026-07-12T10:08:16Z","type":"event_msg","payload":{"rate_limits":{"limit_id":"codex","limit_name":"Codex","primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1783868885},"secondary":{"used_percent":41,"window_minutes":10080,"resets_at":1784455685}}}}"#

    func testReturnsNewestJSONLFirstAndIgnoresOtherFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let old = root.appendingPathComponent("old.jsonl")
        let latest = root.appendingPathComponent("nested/latest.jsonl")
        let ignored = root.appendingPathComponent("newest.txt")
        try FileManager.default.createDirectory(
            at: latest.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data().write(to: old)
        try Data().write(to: latest)
        try Data().write(to: ignored)
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 1)],
            ofItemAtPath: old.path
        )
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 2)],
            ofItemAtPath: latest.path
        )
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 3)],
            ofItemAtPath: ignored.path
        )

        let files = try CodexSessionLocator(root: root).recentSessionFiles(limit: 10)

        XCTAssertEqual(files.map(\.lastPathComponent), ["latest.jsonl", "old.jsonl"])
    }

    func testQuotaReaderRequestsThirtyRecentSessionFiles() throws {
        let locator = RecordingLocator(files: [])

        _ = try CodexQuotaReader(locator: locator).readLatest()

        XCTAssertEqual(locator.limits, [30])
    }

    func testQuotaReaderSkipsNewestInvalidFileAndReturnsFirstValidSnapshot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let newestInvalid = root.appendingPathComponent("newest-invalid.jsonl")
        let firstValid = root.appendingPathComponent("first-valid.jsonl")
        try "not-json\n".write(to: newestInvalid, atomically: true, encoding: .utf8)
        try validSnapshotLine.write(to: firstValid, atomically: true, encoding: .utf8)
        let locator = RecordingLocator(files: [newestInvalid, firstValid])

        let snapshot = try CodexQuotaReader(locator: locator).readLatest()

        XCTAssertEqual(snapshot?.limitID, "codex")
        XCTAssertEqual(snapshot?.limitName, "Codex")
    }

    func testQuotaReaderReturnsNilWhenNoSessionContainsAValidSnapshot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let invalid = root.appendingPathComponent("invalid.jsonl")
        let unrelated = root.appendingPathComponent("unrelated.jsonl")
        try "not-json\n".write(to: invalid, atomically: true, encoding: .utf8)
        try #"{"type":"event_msg","payload":{}}"#.write(
            to: unrelated,
            atomically: true,
            encoding: .utf8
        )
        let locator = RecordingLocator(files: [invalid, unrelated])

        let snapshot = try CodexQuotaReader(locator: locator).readLatest()

        XCTAssertNil(snapshot)
    }
}
