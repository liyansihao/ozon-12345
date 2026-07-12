import Foundation

protocol WidgetPlacementStoring: AnyObject {
    var placement: WidgetPlacement? { get }
    var isVisible: Bool { get set }
    func save(placement: WidgetPlacement)
}

final class WidgetPlacementStore: WidgetPlacementStoring {
    private let defaults: UserDefaults
    private let placementKey = "desktopWidget.placement"
    private let visibilityKey = "desktopWidget.isVisible"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var placement: WidgetPlacement? {
        defaults.data(forKey: placementKey).flatMap {
            try? JSONDecoder().decode(WidgetPlacement.self, from: $0)
        }
    }

    var isVisible: Bool {
        get {
            defaults.object(forKey: visibilityKey) == nil
                ? true
                : defaults.bool(forKey: visibilityKey)
        }
        set {
            defaults.set(newValue, forKey: visibilityKey)
        }
    }

    func save(placement: WidgetPlacement) {
        defaults.set(try? JSONEncoder().encode(placement), forKey: placementKey)
    }
}
