import AppKit
import ColorSync
import Combine
import SwiftUI

struct WidgetScreen: Equatable {
    let id: String
    let visibleFrame: CGRect
    let isMain: Bool
}

@MainActor
protocol DesktopWidgetPaneling: AnyObject {
    var frame: CGRect { get }
    var onDragEnded: ((CGRect) -> Void)? { get set }
    func setFrame(_ frame: CGRect)
    func show()
    func hide()
}

extension DesktopWidgetPanel: DesktopWidgetPaneling {
    func setFrame(_ frame: CGRect) { setFrame(frame, display: true) }
    func show() { orderFrontRegardless() }
    func hide() { orderOut(nil) }
}

@MainActor
protocol DesktopWidgetControlling: AnyObject {
    var isVisible: Bool { get }
    func show()
    func hide()
    func toggle()
}

@MainActor
final class DesktopWidgetController: ObservableObject, DesktopWidgetControlling {
    typealias PanelFactory = @MainActor (
        CGRect,
        QuotaStore,
        @escaping () -> Void,
        @escaping () -> Void
    ) -> DesktopWidgetPaneling

    @Published private(set) var isVisible: Bool
    let quotaStore: QuotaStore
    let widgetSize = CGSize(width: 300, height: 150)

    private let placementStore: WidgetPlacementStoring
    private let screens: @MainActor () -> [WidgetScreen]
    private var panel: DesktopWidgetPaneling!
    private var screenObserver: NSObjectProtocol?
    private var notificationCenter: NotificationCenter?

    init(
        quotaStore: QuotaStore,
        placementStore: WidgetPlacementStoring = WidgetPlacementStore(),
        screens: @escaping @MainActor () -> [WidgetScreen] = DesktopWidgetController.currentScreens,
        panelFactory: PanelFactory = DesktopWidgetController.makePanel,
        notificationCenter: NotificationCenter? = .default
    ) {
        self.quotaStore = quotaStore
        self.placementStore = placementStore
        self.screens = screens
        self.notificationCenter = notificationCenter
        isVisible = placementStore.isVisible

        let initialFrame = Self.restoredFrame(
            placement: placementStore.placement,
            screens: screens(),
            widgetSize: widgetSize
        )
        panel = panelFactory(
            initialFrame,
            quotaStore,
            { Task { @MainActor [weak quotaStore] in await quotaStore?.refresh() } },
            { [weak self] in self?.hide() }
        )
        panel.setFrame(initialFrame)

        panel.onDragEnded = { [weak self] frame in
            self?.dragDidEnd(frame: frame)
        }

        if let notificationCenter {
            screenObserver = notificationCenter.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.screenParametersDidChange() }
            }
        }

        isVisible ? panel.show() : panel.hide()
    }

    deinit {
        if let screenObserver { notificationCenter?.removeObserver(screenObserver) }
    }

    func show() {
        guard !isVisible else { return }
        isVisible = true
        placementStore.isVisible = true
        panel.show()
    }

    func hide() {
        guard isVisible else { return }
        isVisible = false
        placementStore.isVisible = false
        panel.hide()
    }

    func toggle() {
        isVisible ? hide() : show()
    }

    func screenParametersDidChange() {
        let availableScreens = screens()
        guard let main = availableScreens.first(where: \WidgetScreen.isMain) ?? availableScreens.first else {
            return
        }

        guard let target = availableScreens.first(where: { $0.visibleFrame.contains(panel.frame.center) }) else {
            panel.setFrame(WidgetPlacement.defaultFrame(widgetSize: widgetSize, visibleFrame: main.visibleFrame))
            save(frame: panel.frame, on: main)
            return
        }

        panel.setFrame(WidgetPlacement.clamped(frame: panel.frame, visibleFrame: target.visibleFrame))
        save(frame: panel.frame, on: target)
    }

    private func dragDidEnd(frame: CGRect) {
        let availableScreens = screens()
        let target = availableScreens.first(where: { $0.visibleFrame.contains(frame.center) })
            ?? availableScreens.first(where: \WidgetScreen.isMain)
            ?? availableScreens.first
        guard let target else { return }
        let clampedFrame = WidgetPlacement.clamped(frame: frame, visibleFrame: target.visibleFrame)
        panel.setFrame(clampedFrame)
        save(frame: clampedFrame, on: target)
    }

    private func save(frame: CGRect, on screen: WidgetScreen) {
        placementStore.save(placement: WidgetPlacement.normalized(
            frame: frame,
            visibleFrame: screen.visibleFrame,
            screenID: screen.id
        ))
    }

    private static func restoredFrame(
        placement: WidgetPlacement?,
        screens: [WidgetScreen],
        widgetSize: CGSize
    ) -> CGRect {
        if let placement,
           placement.x.isFinite,
           placement.y.isFinite,
           let screen = screens.first(where: { $0.id == placement.screenID }) {
            return placement.restoredFrame(widgetSize: widgetSize, visibleFrame: screen.visibleFrame)
        }
        guard let main = screens.first(where: \WidgetScreen.isMain) ?? screens.first else {
            return CGRect(origin: .zero, size: widgetSize)
        }
        return WidgetPlacement.defaultFrame(widgetSize: widgetSize, visibleFrame: main.visibleFrame)
    }

    private static func currentScreens() -> [WidgetScreen] {
        let main = NSScreen.main
        return NSScreen.screens.map { screen in
            let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            let displayID = number.map(CGDirectDisplayID.init(truncating:))
            return WidgetScreen(
                id: displayID.map {
                    stableScreenID(displayID: $0, fallback: number?.stringValue ?? String(describing: screen))
                } ?? String(describing: screen),
                visibleFrame: screen.visibleFrame,
                isMain: screen === main
            )
        }
    }

    static func stableScreenID(
        displayID: CGDirectDisplayID,
        fallback: String,
        uuidProvider: @MainActor (CGDirectDisplayID) -> String? = displayUUID
    ) -> String {
        uuidProvider(displayID) ?? fallback
    }

    private static func displayUUID(for displayID: CGDirectDisplayID) -> String? {
        guard let reference = CGDisplayCreateUUIDFromDisplayID(displayID) else { return nil }
        let uuid = reference.takeRetainedValue()
        return CFUUIDCreateString(nil, uuid) as String?
    }

    private static func makePanel(
        frame: CGRect,
        store: QuotaStore,
        onRefresh: @escaping () -> Void,
        onHide: @escaping () -> Void
    ) -> DesktopWidgetPaneling {
        let panel = DesktopWidgetPanel(contentRect: frame)
        panel.contentView = NSHostingView(rootView: DesktopWidgetView(
            store: store,
            onRefresh: onRefresh,
            onHide: onHide
        ))
        return panel
    }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}
