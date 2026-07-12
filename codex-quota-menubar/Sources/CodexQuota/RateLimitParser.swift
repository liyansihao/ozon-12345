import Foundation

private struct Envelope: Decodable {
    struct Payload: Decodable {
        struct Limits: Decodable {
            struct Window: Decodable {
                let usedPercent: Double
                let windowMinutes: Int
                let resetsAt: TimeInterval

                enum CodingKeys: String, CodingKey {
                    case usedPercent = "used_percent"
                    case windowMinutes = "window_minutes"
                    case resetsAt = "resets_at"
                }
            }

            let limitID: String
            let limitName: String
            let primary: Window
            let secondary: Window

            enum CodingKeys: String, CodingKey {
                case limitID = "limit_id"
                case limitName = "limit_name"
                case primary
                case secondary
            }
        }

        let rateLimits: Limits?

        enum CodingKeys: String, CodingKey {
            case rateLimits = "rate_limits"
        }
    }

    let payload: Payload?
}

enum RateLimitParsing {
    static func parseLatest(in text: String, observedAt: Date) -> QuotaSnapshot? {
        let decoder = JSONDecoder()
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard let data = String(line).data(using: .utf8),
                  let limits = try? decoder.decode(Envelope.self, from: data).payload?.rateLimits else {
                continue
            }
            return QuotaSnapshot(
                limitID: limits.limitID,
                limitName: limits.limitName,
                primary: .init(
                    usedPercent: limits.primary.usedPercent,
                    windowMinutes: limits.primary.windowMinutes,
                    resetsAt: Date(timeIntervalSince1970: limits.primary.resetsAt)
                ),
                secondary: .init(
                    usedPercent: limits.secondary.usedPercent,
                    windowMinutes: limits.secondary.windowMinutes,
                    resetsAt: Date(timeIntervalSince1970: limits.secondary.resetsAt)
                ),
                observedAt: observedAt
            )
        }
        return nil
    }
}

struct RateLimitParser: Sendable {
    let maximumBytes = 1_048_576

    func parseLatest(from url: URL) throws -> QuotaSnapshot? {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let size = try handle.seekToEnd()
        let start = size > UInt64(maximumBytes) ? size - UInt64(maximumBytes) : 0
        try handle.seek(toOffset: start)
        let data = try handle.readToEnd() ?? Data()
        let text = String(decoding: data, as: UTF8.self)
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .now
        return RateLimitParsing.parseLatest(in: text, observedAt: modified)
    }
}
