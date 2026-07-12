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

    func testQuotaReaderSkipsDisappearingNewestFile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let missing = root.appendingPathComponent("disappeared.jsonl")
        let older = root.appendingPathComponent("older.jsonl")
        try validSnapshotLine.write(to: older, atomically: true, encoding: .utf8)

        let snapshot = try CodexQuotaReader(locator: RecordingLocator(files: [missing, older])).readLatest()

        XCTAssertEqual(snapshot?.limitID, "codex")
    }

    func testQuotaReaderSkipsNewestCandidateThatCannotBeOpenedAsAFile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let unreadable = root.appendingPathComponent("directory.jsonl")
        let older = root.appendingPathComponent("older.jsonl")
        try FileManager.default.createDirectory(at: unreadable, withIntermediateDirectories: true)
        try validSnapshotLine.write(to: older, atomically: true, encoding: .utf8)

        let snapshot = try CodexQuotaReader(locator: RecordingLocator(files: [unreadable, older])).readLatest()

        XCTAssertEqual(snapshot?.limitID, "codex")
    }

    func testQuotaReaderThrowsWhenEveryCandidateFailsToRead() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let first = root.appendingPathComponent("first.jsonl")
        let second = root.appendingPathComponent("second.jsonl")

        XCTAssertThrowsError(
            try CodexQuotaReader(locator: RecordingLocator(files: [first, second])).readLatest()
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("first.jsonl") || error.localizedDescription.contains("second.jsonl"))
        }
    }

    func testRecentDateDirectoriesAreDirectCalendarPathsWithoutRootEnumeration() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = Date(timeIntervalSince1970: 1_767_225_600) // 2026-01-01T00:00:00Z

        let directories = CodexSessionLocator.recentDateDirectories(
            below: root,
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(directories.count, 32)
        XCTAssertEqual(directories[0], root.appendingPathComponent("2026/01/01"))
        XCTAssertEqual(directories[1], root.appendingPathComponent("2025/12/31"))
        XCTAssertEqual(directories.last, root.appendingPathComponent("2025/12/01"))
    }

    func testDateLayoutFindsNestedNewestFilesAndObeysLimit() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let day = root.appendingPathComponent("2026/07/12")
        try FileManager.default.createDirectory(at: day.appendingPathComponent("nested"), withIntermediateDirectories: true)
        let old = day.appendingPathComponent("old.jsonl")
        let newest = day.appendingPathComponent("nested/newest.jsonl")
        try Data().write(to: old)
        try Data().write(to: newest)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: old.path)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 2)], ofItemAtPath: newest.path)

        let files = try CodexSessionLocator(root: root).recentSessionFiles(limit: 1)

        XCTAssertEqual(files.map(\.lastPathComponent), ["newest.jsonl"])
    }

    func testFallbackTraversalHasTotalEntryBudget() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for index in 0..<4_200 {
            try Data().write(to: root.appendingPathComponent(String(format: "%04d.jsonl", index)))
        }

        let files = try CodexSessionLocator(root: root).recentSessionFiles(limit: 5_000)

        XCTAssertEqual(files.count, 4_096)
    }

    func testMissingFallbackRootPropagatesTraversalError() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)

        XCTAssertThrowsError(try CodexSessionLocator(root: root).recentSessionFiles(limit: 1))
    }
}
