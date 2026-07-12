import AppKit

final class DesktopWidgetPanel: NSPanel {
    var onDragEnded: ((NSRect) -> Void)?

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func performWidgetDrag(with event: NSEvent) {
        let initialOrigin = frame.origin
        performDrag(with: event)
        if frame.origin != initialOrigin {
            onDragEnded?(frame)
        }
    }
}

final class DesktopWidgetDragRegionView: NSView {
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    override func mouseDown(with event: NSEvent) {
        (window as? DesktopWidgetPanel)?.performWidgetDrag(with: event)
    }
}
