import SwiftUI
import Combine

@MainActor
final class AutomaticRefreshOwner {
    init(store: QuotaStore) {
        store.startAutomaticRefresh()
    }
}

@MainActor
final class CodexQuotaAppModel: ObservableObject {
    let store: QuotaStore
    let automaticRefreshOwner: AutomaticRefreshOwner
    let widgetController: DesktopWidgetController

    private var storeChanges: AnyCancellable?

    init() {
        let store = QuotaStore()
        self.store = store
        automaticRefreshOwner = AutomaticRefreshOwner(store: store)
        widgetController = DesktopWidgetController(quotaStore: store)
        storeChanges = store.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }
}

@main
struct CodexQuotaApp: App {
    @StateObject private var model: CodexQuotaAppModel

    init() {
        _model = StateObject(wrappedValue: CodexQuotaAppModel())
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(store: model.store, widgetController: model.widgetController)
        } label: {
            switch model.store.state {
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
