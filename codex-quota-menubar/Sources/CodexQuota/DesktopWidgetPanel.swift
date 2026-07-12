import AppKit

final class DesktopWidgetPanel: NSPanel {
    var onDragEnded: ((NSRect) -> Void)?

    private var dragStartMouseLocation: NSPoint?
    private var dragStartFrameOrigin: NSPoint?
    private var didDrag = false

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

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            dragStartMouseLocation = NSEvent.mouseLocation
            dragStartFrameOrigin = frame.origin
            didDrag = false

        case .leftMouseDragged:
            if let startMouseLocation = dragStartMouseLocation,
               let startFrameOrigin = dragStartFrameOrigin {
                let currentMouseLocation = NSEvent.mouseLocation
                let newOrigin = NSPoint(
                    x: startFrameOrigin.x + currentMouseLocation.x - startMouseLocation.x,
                    y: startFrameOrigin.y + currentMouseLocation.y - startMouseLocation.y
                )
                setFrameOrigin(newOrigin)
                didDrag = true
            }

        case .leftMouseUp:
            let shouldNotify = didDrag
            dragStartMouseLocation = nil
            dragStartFrameOrigin = nil
            didDrag = false
            if shouldNotify {
                onDragEnded?(frame)
            }

        default:
            break
        }

        super.sendEvent(event)
    }
}
