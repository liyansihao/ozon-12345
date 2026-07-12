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

    private final class OverlappingReader: @unchecked Sendable {
        private let condition = NSCondition()
        private let olderSnapshot: QuotaSnapshot
        private let newerSnapshot: QuotaSnapshot
        private var callCount = 0
        private var shouldFinishFirstCall = false

        init(olderSnapshot: QuotaSnapshot, newerSnapshot: QuotaSnapshot) {
            self.olderSnapshot = olderSnapshot
            self.newerSnapshot = newerSnapshot
        }

        func read() -> QuotaSnapshot {
            condition.lock()
            callCount += 1
            let call = callCount
            condition.broadcast()

            if call == 1 {
                while !shouldFinishFirstCall {
                    condition.wait()
                }
            }

            condition.unlock()
            return call == 1 ? olderSnapshot : newerSnapshot
        }

        func waitUntilFirstCallStarts() async {
            await Task.detached { [self] in
                blockingWaitUntilFirstCallStarts()
            }.value
        }

        private func blockingWaitUntilFirstCallStarts() {
            condition.lock()
            while callCount < 1 {
                condition.wait()
            }
            condition.unlock()
        }

        func finishFirstCall() {
            condition.lock()
            shouldFinishFirstCall = true
            condition.broadcast()
            condition.unlock()
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

    func testNewerRefreshWinsWhenOlderRefreshFinishesLast() async {
        let olderSnapshot = QuotaSnapshot(
            limitID: "older",
            limitName: "Codex",
            primary: .init(usedPercent: 10, windowMinutes: 300, resetsAt: .now),
            secondary: .init(usedPercent: 20, windowMinutes: 10080, resetsAt: .now),
            observedAt: .now
        )
        let newerSnapshot = QuotaSnapshot(
            limitID: "newer",
            limitName: "Codex",
            primary: .init(usedPercent: 30, windowMinutes: 300, resetsAt: .now),
            secondary: .init(usedPercent: 40, windowMinutes: 10080, resetsAt: .now),
            observedAt: .now
        )
        let reader = OverlappingReader(
            olderSnapshot: olderSnapshot,
            newerSnapshot: newerSnapshot
        )
        let store = QuotaStore(reader: { reader.read() }, refreshInterval: 60)

        let firstRefresh = Task.detached { await store.refresh() }
        await reader.waitUntilFirstCallStarts()

        await store.refresh()
        XCTAssertEqual(store.state, .available(newerSnapshot, isStale: false))

        reader.finishFirstCall()
        await firstRefresh.value

        XCTAssertEqual(store.state, .available(newerSnapshot, isStale: false))
    }
}
