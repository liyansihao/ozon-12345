import SwiftUI

@main
struct CodexQuotaApp: App {
    @StateObject private var store = QuotaStore()

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
