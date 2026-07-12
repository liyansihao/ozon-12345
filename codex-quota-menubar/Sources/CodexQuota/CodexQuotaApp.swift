import SwiftUI

@MainActor
final class AutomaticRefreshOwner {
    init(store: QuotaStore) {
        store.startAutomaticRefresh()
    }
}

@main
struct CodexQuotaApp: App {
    @StateObject private var store: QuotaStore
    private let automaticRefreshOwner: AutomaticRefreshOwner

    init() {
        let store = QuotaStore()
        _store = StateObject(wrappedValue: store)
        automaticRefreshOwner = AutomaticRefreshOwner(store: store)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(store: store)
        } label: {
            switch store.state {
            case let .available(snapshot, _):
                Label(
                    "\(Int(snapshot.mostConstrainedRemainingPercent.rounded()))%",
                    systemImage: "gauge.with.dots.needle.50percent"
                )
            default:
                Label("Codex", systemImage: "gauge.with.dots.needle.0percent")
            }
        }
        .menuBarExtraStyle(.window)
    }
}
