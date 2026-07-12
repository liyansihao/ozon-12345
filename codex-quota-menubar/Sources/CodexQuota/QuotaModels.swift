import Foundation

struct QuotaWindow: Equatable, Sendable {
    let usedPercent: Double
    let windowMinutes: Int
    let resetsAt: Date

    var normalizedUsedPercent: Double { min(100, max(0, usedPercent)) }
    var remainingPercent: Double { 100 - normalizedUsedPercent }
    var displayName: String {
        switch windowMinutes {
        case 300: return "5 小时额度"
        case 10080: return "每周额度"
        default: return "\(windowMinutes) 分钟额度"
        }
    }
}

struct QuotaSnapshot: Equatable, Sendable {
    let limitID: String
    let limitName: String
    let primary: QuotaWindow
    let secondary: QuotaWindow
    let observedAt: Date

    var mostConstrainedRemainingPercent: Double {
        min(primary.remainingPercent, secondary.remainingPercent)
    }
}

enum QuotaLoadState: Equatable, Sendable {
    case loading
    case available(QuotaSnapshot, isStale: Bool)
    case empty(String)
    case failed(String)
}
