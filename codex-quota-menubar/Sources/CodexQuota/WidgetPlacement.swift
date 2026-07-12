import Foundation

struct WidgetPlacement: Codable, Equatable, Sendable {
    let screenID: String
    let x: Double
    let y: Double

    static let margin: CGFloat = 20

    static func defaultFrame(widgetSize: CGSize, visibleFrame: CGRect) -> CGRect {
        CGRect(
            x: visibleFrame.maxX - widgetSize.width - margin,
            y: visibleFrame.maxY - widgetSize.height - margin,
            width: widgetSize.width,
            height: widgetSize.height
        )
    }

    static func normalized(frame: CGRect, visibleFrame: CGRect, screenID: String) -> WidgetPlacement {
        let availableX = max(1, visibleFrame.width - frame.width)
        let availableY = max(1, visibleFrame.height - frame.height)
        return WidgetPlacement(
            screenID: screenID,
            x: (frame.minX - visibleFrame.minX) / availableX,
            y: (frame.minY - visibleFrame.minY) / availableY
        )
    }

    func restoredFrame(widgetSize: CGSize, visibleFrame: CGRect) -> CGRect {
        let frame = CGRect(
            x: visibleFrame.minX + x * max(0, visibleFrame.width - widgetSize.width),
            y: visibleFrame.minY + y * max(0, visibleFrame.height - widgetSize.height),
            width: widgetSize.width,
            height: widgetSize.height
        )
        return Self.clamped(frame: frame, visibleFrame: visibleFrame)
    }

    static func clamped(frame: CGRect, visibleFrame: CGRect) -> CGRect {
        var result = frame
        result.origin.x = min(
            max(result.minX, visibleFrame.minX),
            max(visibleFrame.minX, visibleFrame.maxX - result.width)
        )
        result.origin.y = min(
            max(result.minY, visibleFrame.minY),
            max(visibleFrame.minY, visibleFrame.maxY - result.height)
        )
        return result
    }
}
