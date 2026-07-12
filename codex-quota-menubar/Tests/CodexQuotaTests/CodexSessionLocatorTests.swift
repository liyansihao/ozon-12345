import Foundation
import XCTest
@testable import CodexQuota

final class CodexSessionLocatorTests: XCTestCase {
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
}
