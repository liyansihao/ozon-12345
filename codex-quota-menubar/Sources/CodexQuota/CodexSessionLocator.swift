import Foundation

protocol CodexSessionLocating: Sendable {
    func recentSessionFiles(limit: Int) throws -> [URL]
}

struct CodexSessionLocator: CodexSessionLocating {
    private static let maximumDateDirectories = 32
    private static let maximumScannedEntries = 4_096

    let root: URL

    init(
        root: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions")
    ) {
        self.root = root
    }

    func recentSessionFiles(limit: Int) throws -> [URL] {
        guard limit > 0 else { return [] }
        if root.standardizedFileURL == Self.defaultRoot.standardizedFileURL {
            return try newestFiles(
                below: Self.recentDateDirectories(below: root),
                limit: limit,
                entryBudget: Self.maximumScannedEntries,
                missingRootsAreExpected: true
            )
        }

        return try newestFiles(
            below: [root],
            limit: limit,
            entryBudget: Self.maximumScannedEntries,
            missingRootsAreExpected: false
        )
    }

    private static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/sessions")
    }

    static func recentDateDirectories(
        below root: URL,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [URL] {
        (0..<maximumDateDirectories).compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: -offset, to: now) else {
                return nil
            }
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            guard let year = parts.year, let month = parts.month, let day = parts.day else {
                return nil
            }
            return root.appendingPathComponent(String(format: "%04d/%02d/%02d", year, month, day))
        }
    }

    private func newestFiles(
        below roots: [URL],
        limit: Int,
        entryBudget: Int,
        missingRootsAreExpected: Bool
    ) throws -> [URL] {
        let manager = FileManager.default
        var examined = 0
        var candidates: [(url: URL, modified: Date)] = []
        var firstAccessError: Error?
        for root in roots where examined < entryBudget {
            do {
                guard try root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
                    continue
                }
            } catch {
                if !(missingRootsAreExpected && Self.isMissingFileError(error)), firstAccessError == nil {
                    firstAccessError = error
                }
                continue
            }
            guard let enumerator = manager.enumerator(
                at: root,
                includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
                options: [.skipsHiddenFiles],
                errorHandler: { _, error in
                    if firstAccessError == nil { firstAccessError = error }
                    return true
                }
            ) else {
                if firstAccessError == nil { firstAccessError = CocoaError(.fileReadUnknown) }
                continue
            }
            while examined < entryBudget, let url = enumerator.nextObject() as? URL {
                examined += 1
                do {
                    let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
                    if values.isRegularFile == true, url.pathExtension == "jsonl" {
                        candidates.append((url, values.contentModificationDate ?? .distantPast))
                        candidates.sort { $0.modified > $1.modified }
                        if candidates.count > limit { candidates.removeLast() }
                    }
                } catch {
                    if !Self.isMissingFileError(error), firstAccessError == nil {
                        firstAccessError = error
                    }
                }
            }
        }
        if candidates.isEmpty, let firstAccessError { throw firstAccessError }
        return candidates.map(\.url)
    }

    private static func isMissingFileError(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSCocoaErrorDomain && (
            error.code == CocoaError.fileNoSuchFile.rawValue ||
                error.code == CocoaError.fileReadNoSuchFile.rawValue
        )
    }
}

protocol CodexQuotaReading: Sendable {
    func readLatest() throws -> QuotaSnapshot?
}

struct CodexQuotaReader: CodexQuotaReading, Sendable {
    let locator: any CodexSessionLocating
    let parser: RateLimitParser

    init(
        locator: any CodexSessionLocating = CodexSessionLocator(),
        parser: RateLimitParser = .init()
    ) {
        self.locator = locator
        self.parser = parser
    }

    func readLatest() throws -> QuotaSnapshot? {
        var firstError: Error?
        for url in try locator.recentSessionFiles(limit: 30) {
            do {
                if let snapshot = try parser.parseLatest(from: url) {
                    return snapshot
                }
            } catch {
                if firstError == nil { firstError = error }
            }
        }
        if let firstError { throw firstError }
        return nil
    }
}
