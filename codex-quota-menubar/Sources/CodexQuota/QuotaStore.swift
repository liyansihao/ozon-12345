import Combine
import Foundation

@MainActor
final class QuotaStore: ObservableObject {
    @Published private(set) var state: QuotaLoadState = .loading

    private let reader: @Sendable () throws -> QuotaSnapshot?
    private let refreshInterval: TimeInterval
    private var timerTask: Task<Void, Never>?
    private var lastSnapshot: QuotaSnapshot?

    init(
        reader: @escaping @Sendable () throws -> QuotaSnapshot? = {
            try CodexQuotaReader().readLatest()
        },
        refreshInterval: TimeInterval = 60
    ) {
        self.reader = reader
        self.refreshInterval = refreshInterval
    }

    deinit {
        timerTask?.cancel()
    }

    func refresh() async {
        do {
            let read = reader
            let result = try await Task.detached(priority: .utility) {
                try read()
            }.value

            guard let snapshot = result else {
                state = lastSnapshot.map {
                    .available($0, isStale: true)
                } ?? .empty("等待 Codex 新数据")
                return
            }

            lastSnapshot = snapshot
            state = .available(snapshot, isStale: false)
        } catch {
            state = lastSnapshot.map {
                .available($0, isStale: true)
            } ?? .failed(error.localizedDescription)
        }
    }

    func startAutomaticRefresh() {
        guard timerTask == nil else { return }
        let interval = refreshInterval
        timerTask = Task { [weak self] in
            await self?.refresh()

            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(interval))
                } catch {
                    return
                }
                await self?.refresh()
            }
        }
    }
}
