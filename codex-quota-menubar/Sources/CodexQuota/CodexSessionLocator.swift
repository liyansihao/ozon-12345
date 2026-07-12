import Foundation

protocol CodexSessionLocating: Sendable {
    func recentSessionFiles(limit: Int) throws -> [URL]
}

struct CodexSessionLocator: CodexSessionLocating {
    let root: URL

    init(
        root: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/sessions")
    ) {
        self.root = root
    }

    func recentSessionFiles(limit: Int) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            throw CocoaError(.fileNoSuchFile)
        }

        let files = try enumerator.compactMap { item -> URL? in
            guard let url = item as? URL, url.pathExtension == "jsonl" else { return nil }
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            return values.isRegularFile == true ? url : nil
        }

        return try files.sorted {
            let left = try $0.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate ?? .distantPast
            let right = try $1.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate ?? .distantPast
            return left > right
        }
        .prefix(max(0, limit))
        .map { $0 }
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
        for url in try locator.recentSessionFiles(limit: 30) {
            if let snapshot = try parser.parseLatest(from: url) {
                return snapshot
            }
        }
        return nil
    }
}
