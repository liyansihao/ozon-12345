import Darwin
import Foundation

enum OzonControlCommand: String, CaseIterable {
    case start
    case stop
    case status
    case resume

    var timeout: TimeInterval {
        switch self {
        case .status:
            return 8
        case .start, .stop, .resume:
            return 90
        }
    }
}

struct OzonFunnel: Decodable, Equatable {
    let candidateRequiredFieldsPassed: Int
    let snapshotCategoryPassed: Int
    let costPassed: Int
    let livePriceConfirmed: Int
    let profitPassed: Int
    let erpAccepted: Int
    let online: Int

    enum CodingKeys: String, CodingKey {
        case candidateRequiredFieldsPassed = "candidate_required_fields_passed"
        case snapshotCategoryPassed = "snapshot_category_passed"
        case costPassed = "cost_passed"
        case livePriceConfirmed = "live_price_confirmed"
        case profitPassed = "profit_passed"
        case erpAccepted = "erp_accepted"
        case online
    }

    init(
        candidateRequiredFieldsPassed: Int = 0,
        snapshotCategoryPassed: Int = 0,
        costPassed: Int = 0,
        livePriceConfirmed: Int = 0,
        profitPassed: Int = 0,
        erpAccepted: Int = 0,
        online: Int = 0
    ) {
        self.candidateRequiredFieldsPassed = candidateRequiredFieldsPassed
        self.snapshotCategoryPassed = snapshotCategoryPassed
        self.costPassed = costPassed
        self.livePriceConfirmed = livePriceConfirmed
        self.profitPassed = profitPassed
        self.erpAccepted = erpAccepted
        self.online = online
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        candidateRequiredFieldsPassed = try values.decodeIfPresent(Int.self, forKey: .candidateRequiredFieldsPassed) ?? 0
        snapshotCategoryPassed = try values.decodeIfPresent(Int.self, forKey: .snapshotCategoryPassed) ?? 0
        costPassed = try values.decodeIfPresent(Int.self, forKey: .costPassed) ?? 0
        livePriceConfirmed = try values.decodeIfPresent(Int.self, forKey: .livePriceConfirmed) ?? 0
        profitPassed = try values.decodeIfPresent(Int.self, forKey: .profitPassed) ?? 0
        erpAccepted = try values.decodeIfPresent(Int.self, forKey: .erpAccepted) ?? 0
        online = try values.decodeIfPresent(Int.self, forKey: .online) ?? 0
    }
}

struct OzonOwners: Decodable, Equatable {
    let supervisor: Int
    let worker: Int
    let profile: Int

    init(supervisor: Int = 0, worker: Int = 0, profile: Int = 0) {
        self.supervisor = supervisor
        self.worker = worker
        self.profile = profile
    }

    enum CodingKeys: String, CodingKey {
        case supervisor
        case worker
        case profile
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        supervisor = try values.decodeIfPresent(Int.self, forKey: .supervisor) ?? 0
        worker = try values.decodeIfPresent(Int.self, forKey: .worker) ?? 0
        profile = try values.decodeIfPresent(Int.self, forKey: .profile) ?? 0
    }
}

struct OzonProductionStatus: Decodable, Equatable {
    let at: String?
    let status: String
    let reason: String?
    let runID: String?
    let target: Int
    let remaining: Int?
    let funnel: OzonFunnel
    let owners: OzonOwners

    enum CodingKeys: String, CodingKey {
        case at
        case status
        case reason
        case runID = "run_id"
        case target
        case remaining
        case funnel
        case owners
        case strict
    }

    init(
        at: String? = nil,
        status: String,
        reason: String? = nil,
        runID: String? = nil,
        target: Int = 500,
        remaining: Int? = nil,
        funnel: OzonFunnel = OzonFunnel(),
        owners: OzonOwners = OzonOwners()
    ) {
        self.at = at
        self.status = status
        self.reason = reason
        self.runID = runID
        self.target = target
        self.remaining = remaining
        self.funnel = funnel
        self.owners = owners
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        at = try values.decodeIfPresent(String.self, forKey: .at)
        status = (try values.decodeIfPresent(String.self, forKey: .status) ?? "UNKNOWN").uppercased()
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        runID = try values.decodeIfPresent(String.self, forKey: .runID)
        target = max(1, try values.decodeIfPresent(Int.self, forKey: .target) ?? 500)
        remaining = try values.decodeIfPresent(Int.self, forKey: .remaining)
        owners = try values.decodeIfPresent(OzonOwners.self, forKey: .owners) ?? OzonOwners()

        if let directFunnel = try values.decodeIfPresent(OzonFunnel.self, forKey: .funnel) {
            funnel = directFunnel
        } else {
            let legacyAccepted = try values.decodeIfPresent(Int.self, forKey: .strict) ?? 0
            funnel = OzonFunnel(erpAccepted: legacyAccepted)
        }
    }

    var accepted: Int {
        max(0, funnel.erpAccepted)
    }

    var online: Int {
        max(0, funnel.online)
    }

    var remainingCount: Int {
        max(0, remaining ?? (target - accepted))
    }
}

struct OzonButtonPolicy: Equatable {
    let canStart: Bool
    let canStop: Bool
    let canResumeVerification: Bool

    static func forStatus(_ rawStatus: String, owners: OzonOwners = OzonOwners()) -> OzonButtonPolicy {
        switch rawStatus.uppercased() {
        case "STOPPED":
            let ownersReleased = owners.supervisor == 0 && owners.worker == 0 && owners.profile == 0
            return OzonButtonPolicy(canStart: ownersReleased, canStop: false, canResumeVerification: false)
        case "WAITING_FOR_VERIFICATION":
            return OzonButtonPolicy(canStart: false, canStop: true, canResumeVerification: true)
        case "STARTING", "PREFLIGHTING_CAPACITY", "PREWARMING_CANDIDATES",
             "PREPARING_CANDIDATE_BUFFER", "WAITING_FOR_QUOTA_RESET", "RUNNING", "RECOVERING":
            return OzonButtonPolicy(canStart: false, canStop: true, canResumeVerification: false)
        case "TARGET_COMPLETE", "FATAL_STOP", "RETIRED", "UNKNOWN":
            return OzonButtonPolicy(canStart: false, canStop: false, canResumeVerification: false)
        default:
            return OzonButtonPolicy(canStart: false, canStop: false, canResumeVerification: false)
        }
    }
}

struct OzonCommandResult {
    let command: OzonControlCommand
    let exitCode: Int32
    let stdout: String
    let stderr: String
    let timedOut: Bool
    let launchError: String?

    var succeeded: Bool {
        !timedOut && launchError == nil && exitCode == 0
    }

    var bestErrorText: String {
        if timedOut {
            return "命令超时；控制面板已停止等待，未直接操作 supervisor、worker 或浏览器。"
        }
        if let launchError, !launchError.isEmpty {
            return launchError
        }
        let errorText = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !errorText.isEmpty {
            return errorText
        }
        let outputText = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !outputText.isEmpty {
            return outputText
        }
        return "命令失败，退出码 \(exitCode)。"
    }
}

final class OzonScriptRunner {
    let scriptURL: URL
    private let environment: [String: String]?

    init(scriptURL: URL, environment: [String: String]? = nil) {
        self.scriptURL = scriptURL
        self.environment = environment
    }

    func execute(_ command: OzonControlCommand, timeout: TimeInterval? = nil) -> OzonCommandResult {
        guard FileManager.default.isExecutableFile(atPath: scriptURL.path) else {
            return OzonCommandResult(
                command: command,
                exitCode: -1,
                stdout: "",
                stderr: "",
                timedOut: false,
                launchError: "找不到可执行的生产控制脚本：\(scriptURL.path)"
            )
        }

        let process = Process()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let completion = DispatchSemaphore(value: 0)
        let readGroup = DispatchGroup()
        let outputBox = NetworkDataBox()
        let errorBox = NetworkDataBox()

        process.executableURL = scriptURL
        process.arguments = [command.rawValue]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        if let environment {
            process.environment = environment
        }
        process.terminationHandler = { _ in completion.signal() }

        do {
            try process.run()
        } catch {
            return OzonCommandResult(
                command: command,
                exitCode: -1,
                stdout: "",
                stderr: "",
                timedOut: false,
                launchError: "无法启动控制脚本：\(error.localizedDescription)"
            )
        }

        readGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            outputBox.data = outputPipe.fileHandleForReading.readDataToEndOfFile()
            readGroup.leave()
        }
        readGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            errorBox.data = errorPipe.fileHandleForReading.readDataToEndOfFile()
            readGroup.leave()
        }

        let waitResult = completion.wait(timeout: .now() + (timeout ?? command.timeout))
        let timedOut = waitResult == .timedOut
        if timedOut {
            process.terminate()
            if completion.wait(timeout: .now() + 2) == .timedOut {
                Darwin.kill(process.processIdentifier, SIGKILL)
                _ = completion.wait(timeout: .now() + 2)
            }
        }

        _ = readGroup.wait(timeout: .now() + 3)
        let outputData = outputBox.data ?? Data()
        let errorData = errorBox.data ?? Data()
        return OzonCommandResult(
            command: command,
            exitCode: process.isRunning ? -1 : process.terminationStatus,
            stdout: String(data: outputData, encoding: .utf8) ?? "",
            stderr: String(data: errorData, encoding: .utf8) ?? "",
            timedOut: timedOut,
            launchError: nil
        )
    }
}

struct OzonCurrentStore: Equatable {
    let id: Int?
    let name: String?

    var displayName: String {
        let cleanName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !cleanName.isEmpty, let id {
            return "\(cleanName)（\(id)）"
        }
        if !cleanName.isEmpty {
            return cleanName
        }
        if let id {
            return "店铺 \(id)"
        }
        return "—"
    }
}

struct OzonLocalContext: Equatable {
    let currentStore: OzonCurrentStore
    let browserTabCount: Int?
    let lastRuntimeError: OzonRuntimeError?
}

struct OzonRuntimeError: Equatable {
    let at: String?
    let stage: String?
    let message: String

    var displayText: String {
        let cleanStage = stage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let prefix = cleanStage.isEmpty ? "" : "[\(cleanStage)] "
        return "\(prefix)\(message)"
    }
}

private struct CurrentRunRecord: Decodable {
    let runDir: String?
    let currentStoreID: Int?

    enum CodingKeys: String, CodingKey {
        case runDir = "run_dir"
        case currentStoreID = "current_store_id"
    }
}

private struct CurrentStoreRecord: Decodable {
    let storeID: Int?
    let storeName: String?

    enum CodingKeys: String, CodingKey {
        case storeID = "store_id"
        case storeName = "store_name"
    }
}

private struct StoreConfig: Decodable {
    let id: Int
    let name: String?
}

private struct ProductionConfig: Decodable {
    let stores: [StoreConfig]?
}

private struct RuntimeErrorRecord: Decodable {
    let at: String?
    let stage: String?
    let error: String?
    let message: String?
    let reason: String?
}

enum OzonBrowserTargetCounter {
    static func pageCount(from data: Data) -> Int? {
        guard let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return nil
        }
        return rows.filter { String(describing: $0["type"] ?? "").lowercased() == "page" }.count
    }
}

final class OzonLocalInspector {
    private let stateRoot: URL
    private let configURL: URL
    private let cdpListURL: URL
    private let cdpTimeout: TimeInterval

    init(stateRoot: URL, configURL: URL, cdpListURL: URL, cdpTimeout: TimeInterval = 2) {
        self.stateRoot = stateRoot
        self.configURL = configURL
        self.cdpListURL = cdpListURL
        self.cdpTimeout = cdpTimeout
    }

    func inspect() -> OzonLocalContext {
        let currentRun = readCurrentRun()
        return OzonLocalContext(
            currentStore: readCurrentStore(currentRun),
            browserTabCount: readBrowserTabCount(),
            lastRuntimeError: readLastRuntimeError(currentRun)
        )
    }

    private func readCurrentRun() -> CurrentRunRecord? {
        let currentRunURL = stateRoot.appendingPathComponent("current_run.json")
        guard let currentRunData = try? Data(contentsOf: currentRunURL),
              let currentRun = try? JSONDecoder().decode(CurrentRunRecord.self, from: currentRunData) else {
            return nil
        }
        return currentRun
    }

    private func validatedRunURL(_ currentRun: CurrentRunRecord?) -> URL? {
        guard let runDir = currentRun?.runDir, !runDir.isEmpty else { return nil }
        let runURL = URL(fileURLWithPath: runDir, isDirectory: true).standardizedFileURL
        let normalizedRoot = stateRoot.standardizedFileURL.path + "/runs/"
        guard runURL.path.hasPrefix(normalizedRoot) else { return nil }
        return runURL
    }

    private func readCurrentStore(_ currentRun: CurrentRunRecord?) -> OzonCurrentStore {
        guard let currentRun else {
            return OzonCurrentStore(id: nil, name: nil)
        }
        let decoder = JSONDecoder()

        var record: CurrentStoreRecord?
        if let runURL = validatedRunURL(currentRun),
           let data = try? Data(contentsOf: runURL.appendingPathComponent("current_store.json")) {
            record = try? decoder.decode(CurrentStoreRecord.self, from: data)
        }

        if record == nil,
           let data = try? Data(contentsOf: stateRoot.appendingPathComponent("current_store.json")) {
            record = try? decoder.decode(CurrentStoreRecord.self, from: data)
        }

        let storeID = record?.storeID ?? currentRun.currentStoreID
        var storeName = record?.storeName
        if (storeName ?? "").isEmpty,
           let configData = try? Data(contentsOf: configURL),
           let config = try? decoder.decode(ProductionConfig.self, from: configData) {
            storeName = config.stores?.first(where: { $0.id == storeID })?.name
        }
        return OzonCurrentStore(id: storeID, name: storeName)
    }

    private func readLastRuntimeError(_ currentRun: CurrentRunRecord?) -> OzonRuntimeError? {
        guard let runURL = validatedRunURL(currentRun) else { return nil }
        let filename = runURL.appendingPathComponent("runtime_errors.jsonl")
        guard let handle = try? FileHandle(forReadingFrom: filename) else { return nil }
        defer { handle.closeFile() }

        let endOffset = handle.seekToEndOfFile()
        let maximumBytes: UInt64 = 65_536
        handle.seek(toFileOffset: endOffset > maximumBytes ? endOffset - maximumBytes : 0)
        let tail = handle.readDataToEndOfFile()
        guard let text = String(data: tail, encoding: .utf8) else { return nil }

        let decoder = JSONDecoder()
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard let data = String(line).data(using: .utf8),
                  let row = try? decoder.decode(RuntimeErrorRecord.self, from: data) else {
                continue
            }
            let rawMessage = row.error ?? row.message ?? row.reason ?? ""
            let cleanMessage = rawMessage.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanMessage.isEmpty else { continue }
            let boundedMessage = cleanMessage.count > 300
                ? String(cleanMessage.prefix(299)) + "…"
                : cleanMessage
            return OzonRuntimeError(at: row.at, stage: row.stage, message: boundedMessage)
        }
        return nil
    }

    private func readBrowserTabCount() -> Int? {
        var request = URLRequest(url: cdpListURL)
        request.timeoutInterval = cdpTimeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = cdpTimeout
        configuration.timeoutIntervalForResource = cdpTimeout
        let session = URLSession(configuration: configuration)
        let semaphore = DispatchSemaphore(value: 0)
        let box = NetworkDataBox()
        let task = session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            guard error == nil,
                  let response = response as? HTTPURLResponse,
                  (200 ... 299).contains(response.statusCode) else {
                return
            }
            box.data = data
        }
        task.resume()
        if semaphore.wait(timeout: .now() + cdpTimeout + 0.5) == .timedOut {
            task.cancel()
            session.invalidateAndCancel()
            return nil
        }
        session.finishTasksAndInvalidate()
        guard let data = box.data else { return nil }
        return OzonBrowserTargetCounter.pageCount(from: data)
    }
}

private final class NetworkDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storedData: Data?

    var data: Data? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storedData
        }
        set {
            lock.lock()
            storedData = newValue
            lock.unlock()
        }
    }
}

struct OzonDashboardSnapshot: Equatable {
    let production: OzonProductionStatus
    let local: OzonLocalContext
    let refreshedAt: Date
}

enum OzonControlServiceError: LocalizedError {
    case commandFailed(String)
    case malformedStatus(String)
    case actionNotAllowed(String)
    case stopDidNotSettle(String)

    var errorDescription: String? {
        switch self {
        case .commandFailed(let message):
            return message
        case .malformedStatus(let message):
            return "状态 JSON 无法解析：\(message)"
        case .actionNotAllowed(let status):
            return "当前状态 \(status) 不允许执行这个操作；请先刷新状态。"
        case .stopDidNotSettle(let status):
            return "安全暂停请求已发送，但等待落盘超时；最后状态为 \(status)。请刷新状态确认。"
        }
    }
}

final class OzonControlService {
    private let runner: OzonScriptRunner
    private let inspector: OzonLocalInspector
    private let queue = DispatchQueue(label: "com.local.ozon-control-panel.commands", qos: .userInitiated)
    private let stopSettleTimeout: TimeInterval

    init(runner: OzonScriptRunner, inspector: OzonLocalInspector, stopSettleTimeout: TimeInterval = 60) {
        self.runner = runner
        self.inspector = inspector
        self.stopSettleTimeout = stopSettleTimeout
    }

    func refresh(completion: @escaping (Result<OzonDashboardSnapshot, Error>) -> Void) {
        queue.async {
            completion(Result { try self.loadSnapshot() })
        }
    }

    func perform(
        _ command: OzonControlCommand,
        completion: @escaping (Result<OzonDashboardSnapshot, Error>) -> Void
    ) {
        queue.async {
            completion(Result { try self.performSynchronously(command) })
        }
    }

    func loadSnapshot() throws -> OzonDashboardSnapshot {
        let result = runner.execute(.status)
        let production = try decodeStatus(result)
        return OzonDashboardSnapshot(production: production, local: inspector.inspect(), refreshedAt: Date())
    }

    private func performSynchronously(_ command: OzonControlCommand) throws -> OzonDashboardSnapshot {
        guard command != .status else { return try loadSnapshot() }

        let before = try loadSnapshot()
        let policy = OzonButtonPolicy.forStatus(before.production.status, owners: before.production.owners)
        let allowed: Bool
        switch command {
        case .start:
            allowed = policy.canStart
        case .stop:
            allowed = policy.canStop
        case .resume:
            allowed = policy.canResumeVerification
        case .status:
            allowed = true
        }
        guard allowed else {
            throw OzonControlServiceError.actionNotAllowed(before.production.status)
        }

        let actionResult = runner.execute(command)
        guard actionResult.succeeded else {
            throw OzonControlServiceError.commandFailed(actionResult.bestErrorText)
        }

        if command == .stop {
            let deadline = Date().addingTimeInterval(stopSettleTimeout)
            var latest = before
            while Date() < deadline {
                Thread.sleep(forTimeInterval: 0.75)
                latest = try loadSnapshot()
                if latest.production.status == "STOPPED",
                   latest.production.owners.supervisor == 0,
                   latest.production.owners.worker == 0,
                   latest.production.owners.profile == 0 {
                    return latest
                }
            }
            throw OzonControlServiceError.stopDidNotSettle(latest.production.status)
        }

        Thread.sleep(forTimeInterval: 0.5)
        return try loadSnapshot()
    }

    private func decodeStatus(_ result: OzonCommandResult) throws -> OzonProductionStatus {
        guard result.succeeded else {
            throw OzonControlServiceError.commandFailed(result.bestErrorText)
        }
        do {
            return try JSONDecoder().decode(OzonProductionStatus.self, from: Data(result.stdout.utf8))
        } catch {
            throw OzonControlServiceError.malformedStatus(error.localizedDescription)
        }
    }
}

enum OzonProductionPaths {
    static func make() -> (script: URL, stateRoot: URL, config: URL, cdpList: URL) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let productionRoot = home.appendingPathComponent(".ozon-24h-production", isDirectory: true)
        let appRoot = productionRoot.appendingPathComponent("app", isDirectory: true)
        return (
            script: appRoot.appendingPathComponent("scripts/ozon_24h_production.sh"),
            stateRoot: productionRoot.appendingPathComponent("state", isDirectory: true),
            config: appRoot.appendingPathComponent("config/ozon_24h_production.json"),
            cdpList: URL(string: "http://127.0.0.1:9223/json/list")!
        )
    }
}
