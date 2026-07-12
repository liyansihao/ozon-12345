import Foundation
import XCTest
@testable import CodexQuota

@MainActor
final class QuotaStoreTests: XCTestCase {
    private final class CallCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        func next() -> Int {
            lock.lock()
            defer { lock.unlock() }
            count += 1
            return count
        }
    }

    func testEmptyReaderProducesEmptyState() async {
        let store = QuotaStore(reader: { nil }, refreshInterval: 60)

        await store.refresh()

        XCTAssertEqual(store.state, .empty("等待 Codex 新数据"))
    }

    func testFailureKeepsPreviousSnapshotAsStale() async {
        let snapshot = QuotaSnapshot(
            limitID: "x",
            limitName: "Codex",
            primary: .init(
                usedPercent: 1,
                windowMinutes: 300,
                resetsAt: .now
            ),
            secondary: .init(
                usedPercent: 2,
                windowMinutes: 10080,
                resetsAt: .now
            ),
            observedAt: .now
        )
        let calls = CallCounter()
        let store = QuotaStore(reader: {
            if calls.next() == 1 { return snapshot }
            throw CocoaError(.fileReadNoPermission)
        }, refreshInterval: 60)

        await store.refresh()
        await store.refresh()

        XCTAssertEqual(store.state, .available(snapshot, isStale: true))
    }
}
