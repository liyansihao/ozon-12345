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
        let manager = FileManager.default
        let children = try manager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        let years = try directoryChildren(in: children, matchingDigits: 4)
        if !years.isEmpty {
            var dayDirectories: [URL] = []
            for year in years.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) {
                let months = try directoryChildren(
                    in: manager.contentsOfDirectory(at: year, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]),
                    matchingDigits: 2
                )
                for month in months.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) {
                    let days = try directoryChildren(
                        in: manager.contentsOfDirectory(at: month, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]),
                        matchingDigits: 2
                    )
                    dayDirectories.append(contentsOf: days.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }))
                    if dayDirectories.count >= Self.maximumDateDirectories { break }
                }
                if dayDirectories.count >= Self.maximumDateDirectories { break }
            }
            return try newestFiles(
                below: Array(dayDirectories.prefix(Self.maximumDateDirectories)),
                limit: limit,
                entryBudget: Self.maximumScannedEntries
            )
        }

        return try newestFiles(below: [root], limit: limit, entryBudget: Self.maximumScannedEntries)
    }

    private func directoryChildren(in urls: [URL], matchingDigits count: Int) throws -> [URL] {
        try urls.filter { url in
            let name = url.lastPathComponent
            guard name.count == count, name.allSatisfy(\.isNumber) else { return false }
            return try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true
        }
    }

    private func newestFiles(below roots: [URL], limit: Int, entryBudget: Int) throws -> [URL] {
        let manager = FileManager.default
        var examined = 0
        var candidates: [(url: URL, modified: Date)] = []
        for root in roots where examined < entryBudget {
            guard let enumerator = manager.enumerator(
                at: root,
                includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
                options: [.skipsHiddenFiles],
                errorHandler: { _, _ in true }
            ) else {
                if roots.count == 1 { throw CocoaError(.fileNoSuchFile) }
                continue
            }
            while examined < entryBudget, let url = enumerator.nextObject() as? URL {
                examined += 1
                let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
                if values.isRegularFile == true, url.pathExtension == "jsonl" {
                    candidates.append((url, values.contentModificationDate ?? .distantPast))
                    candidates.sort { $0.modified > $1.modified }
                    if candidates.count > limit { candidates.removeLast() }
                }
            }
        }
        return candidates.map(\.url)
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
