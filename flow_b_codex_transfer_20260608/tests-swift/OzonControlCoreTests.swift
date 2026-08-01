import Foundation

private enum TestFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): return message
        }
    }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw TestFailure.failed(message) }
}

private func write(_ value: String, to url: URL) throws {
    try Data(value.utf8).write(to: url, options: .atomic)
}

private func makeFixture() throws -> (root: URL, script: URL, log: URL, state: URL, config: URL) {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("ozon-control-panel-tests-\(UUID().uuidString)", isDirectory: true)
    let state = root.appendingPathComponent("state", isDirectory: true)
    let run = state.appendingPathComponent("runs/test-run", isDirectory: true)
    try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)

    let script = root.appendingPathComponent("fake-control.sh")
    let log = root.appendingPathComponent("commands.log")
    let scriptBody = """
    #!/bin/sh
    printf '%s\\n' "$1" >> "$FAKE_COMMAND_LOG"
    if [ "${FAKE_MODE:-normal}" = "timeout" ]; then
      exec /bin/sleep 2
    fi
    if [ "${FAKE_MODE:-normal}" = "error" ]; then
      printf '%s\\n' 'fake control failure' >&2
      exit 7
    fi
    if [ -n "${FAKE_STATUS_FILE:-}" ] && [ "$1" = "status" ]; then
      /bin/cat "$FAKE_STATUS_FILE"
      exit 0
    fi
    if [ -n "${FAKE_STATUS_FILE:-}" ] && [ "$1" = "stop" ]; then
      printf '%s\\n' "$FAKE_STOPPED_STATUS_JSON" > "$FAKE_STATUS_FILE"
      printf '%s\\n' '{"ok":true,"stop_requested":true}'
      exit 0
    fi
    if [ "$1" = "status" ]; then
      printf '%s\\n' "${FAKE_STATUS_JSON}"
    else
      printf '{"ok":true,"command":"%s"}\\n' "$1"
    fi
    """
    try write(scriptBody, to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

    try write("""
    {"run_dir":"\(run.path)","current_store_id":104965}
    """, to: state.appendingPathComponent("current_run.json"))
    try write("""
    {"store_id":106640,"store_name":"丽丽三号"}
    """, to: run.appendingPathComponent("current_store.json"))
    try write("""
    {"at":"2026-08-01T01:23:45Z","stage":"direct-source-scan","error":"page.goto failed"}
    """, to: run.appendingPathComponent("runtime_errors.jsonl"))
    let config = root.appendingPathComponent("production.json")
    try write("""
    {"stores":[{"id":104965,"name":"丽丽1号"},{"id":106640,"name":"丽丽三号"}]}
    """, to: config)
    return (root, script, log, state, config)
}

private let runningJSON = """
{"at":"2026-08-01T01:00:00Z","status":"RUNNING","reason":null,"run_id":"test-run","target":500,"remaining":377,"funnel":{"candidate_required_fields_passed":900,"snapshot_category_passed":800,"cost_passed":200,"live_price_confirmed":130,"profit_passed":125,"erp_accepted":123,"online":97},"owners":{"supervisor":1,"worker":1,"profile":1}}
"""

private func testCommandMappingAndParsing() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    var environment = ProcessInfo.processInfo.environment
    environment["FAKE_COMMAND_LOG"] = fixture.log.path
    environment["FAKE_STATUS_JSON"] = runningJSON
    environment["FAKE_MODE"] = "normal"
    let runner = OzonScriptRunner(scriptURL: fixture.script, environment: environment)

    for command in OzonControlCommand.allCases {
        let result = runner.execute(command, timeout: 2)
        try expect(result.succeeded, "\(command.rawValue) should succeed")
    }
    let log = try String(contentsOf: fixture.log, encoding: .utf8)
    try expect(log == "start\nstop\nstatus\nresume\n", "commands must map to one exact fixed argument")

    let inspector = OzonLocalInspector(
        stateRoot: fixture.state,
        configURL: fixture.config,
        cdpListURL: URL(string: "http://127.0.0.1:1/json/list")!,
        cdpTimeout: 0.05
    )
    let service = OzonControlService(runner: runner, inspector: inspector, stopSettleTimeout: 0.1)
    let snapshot = try service.loadSnapshot()
    try expect(snapshot.production.accepted == 123, "ERP accepted count should parse")
    try expect(snapshot.production.remainingCount == 377, "remaining count should parse")
    try expect(snapshot.production.online == 97, "online count should parse")
    try expect(snapshot.production.owners == OzonOwners(supervisor: 1, worker: 1, profile: 1), "owners should parse")
    try expect(snapshot.local.currentStore == OzonCurrentStore(id: 106640, name: "丽丽三号"), "current store should come from run state")
    try expect(snapshot.local.browserTabCount == nil, "unavailable CDP should return nil instead of crashing")
    try expect(snapshot.local.lastRuntimeError?.displayText == "[direct-source-scan] page.goto failed", "latest runtime error should parse")
}

private func testButtonPolicies() throws {
    try expect(
        OzonButtonPolicy.forStatus("RUNNING") == OzonButtonPolicy(canStart: false, canStop: true, canResumeVerification: false),
        "RUNNING policy mismatch"
    )
    try expect(
        OzonButtonPolicy.forStatus("STOPPED") == OzonButtonPolicy(canStart: true, canStop: false, canResumeVerification: false),
        "STOPPED policy mismatch"
    )
    try expect(
        OzonButtonPolicy.forStatus("STOPPED", owners: OzonOwners(supervisor: 1, worker: 0, profile: 0))
            == OzonButtonPolicy(canStart: false, canStop: false, canResumeVerification: false),
        "STOPPED must wait for all owners to release"
    )
    try expect(
        OzonButtonPolicy.forStatus("WAITING_FOR_VERIFICATION") == OzonButtonPolicy(canStart: false, canStop: true, canResumeVerification: true),
        "WAITING_FOR_VERIFICATION policy mismatch"
    )
    try expect(
        OzonButtonPolicy.forStatus("TARGET_COMPLETE") == OzonButtonPolicy(canStart: false, canStop: false, canResumeVerification: false),
        "TARGET_COMPLETE policy mismatch"
    )
    try expect(
        OzonButtonPolicy.forStatus("FATAL_STOP") == OzonButtonPolicy(canStart: false, canStop: false, canResumeVerification: false),
        "FATAL_STOP policy mismatch"
    )
}

private func testBrowserPageCounting() throws {
    let data = Data("""
    [{"type":"page"},{"type":"service_worker"},{"type":"page"}]
    """.utf8)
    try expect(OzonBrowserTargetCounter.pageCount(from: data) == 2, "only page targets should count")
    try expect(OzonBrowserTargetCounter.pageCount(from: Data("not json".utf8)) == nil, "bad CDP JSON should be unavailable")
}

private func testSafeStopWaitsForReleasedOwners() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let statusFile = fixture.root.appendingPathComponent("fake-status.json")
    try write(runningJSON, to: statusFile)
    let stoppedJSON = """
    {"status":"STOPPED","run_id":"test-run","target":500,"remaining":377,"funnel":{"erp_accepted":123,"online":97},"owners":{"supervisor":0,"worker":0,"profile":0}}
    """
    var environment = ProcessInfo.processInfo.environment
    environment["FAKE_COMMAND_LOG"] = fixture.log.path
    environment["FAKE_STATUS_JSON"] = runningJSON
    environment["FAKE_STATUS_FILE"] = statusFile.path
    environment["FAKE_STOPPED_STATUS_JSON"] = stoppedJSON
    environment["FAKE_MODE"] = "normal"
    let runner = OzonScriptRunner(scriptURL: fixture.script, environment: environment)
    let inspector = OzonLocalInspector(
        stateRoot: fixture.state,
        configURL: fixture.config,
        cdpListURL: URL(string: "http://127.0.0.1:1/json/list")!,
        cdpTimeout: 0.05
    )
    let service = OzonControlService(runner: runner, inspector: inspector, stopSettleTimeout: 3)
    let completion = DispatchSemaphore(value: 0)
    let resultBox = ResultBox()
    service.perform(.stop) { result in
        resultBox.result = result
        completion.signal()
    }
    try expect(completion.wait(timeout: .now() + 5) == .success, "safe stop should finish")
    switch resultBox.result {
    case .success(let snapshot):
        try expect(snapshot.production.status == "STOPPED", "safe stop should land in STOPPED")
        try expect(snapshot.production.owners == OzonOwners(), "safe stop must wait for all owners to release")
    case .failure(let error):
        throw TestFailure.failed("safe stop failed: \(error.localizedDescription)")
    case .none:
        throw TestFailure.failed("safe stop returned no result")
    }
    let commands = try String(contentsOf: fixture.log, encoding: .utf8)
    try expect(commands == "status\nstop\nstatus\n", "safe stop must preflight, stop, then poll status")
}

private func testSafeStopDoesNotMisreportFatalOwners() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let statusFile = fixture.root.appendingPathComponent("fake-status.json")
    try write(runningJSON, to: statusFile)
    let fatalJSON = """
    {"status":"FATAL_STOP","reason":"fake fatal","run_id":"test-run","target":500,"remaining":377,"funnel":{"erp_accepted":123,"online":97},"owners":{"supervisor":1,"worker":1,"profile":1}}
    """
    var environment = ProcessInfo.processInfo.environment
    environment["FAKE_COMMAND_LOG"] = fixture.log.path
    environment["FAKE_STATUS_JSON"] = runningJSON
    environment["FAKE_STATUS_FILE"] = statusFile.path
    environment["FAKE_STOPPED_STATUS_JSON"] = fatalJSON
    environment["FAKE_MODE"] = "normal"
    let runner = OzonScriptRunner(scriptURL: fixture.script, environment: environment)
    let inspector = OzonLocalInspector(
        stateRoot: fixture.state,
        configURL: fixture.config,
        cdpListURL: URL(string: "http://127.0.0.1:1/json/list")!,
        cdpTimeout: 0.01
    )
    let service = OzonControlService(runner: runner, inspector: inspector, stopSettleTimeout: 0.8)
    let completion = DispatchSemaphore(value: 0)
    let resultBox = ResultBox()
    service.perform(.stop) { result in
        resultBox.result = result
        completion.signal()
    }
    try expect(completion.wait(timeout: .now() + 4) == .success, "fatal-owner stop test should finish")
    switch resultBox.result {
    case .failure(let error):
        try expect(error.localizedDescription.contains("等待落盘超时"), "fatal owners must not be reported as safely stopped")
    case .success:
        throw TestFailure.failed("FATAL_STOP with live owners must not report safe-stop success")
    case .none:
        throw TestFailure.failed("fatal-owner stop test returned no result")
    }
}

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storedResult: Result<OzonDashboardSnapshot, Error>?

    var result: Result<OzonDashboardSnapshot, Error>? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storedResult
        }
        set {
            lock.lock()
            storedResult = newValue
            lock.unlock()
        }
    }
}

private func testTimeoutAndError() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    var environment = ProcessInfo.processInfo.environment
    environment["FAKE_COMMAND_LOG"] = fixture.log.path
    environment["FAKE_STATUS_JSON"] = runningJSON
    environment["FAKE_MODE"] = "timeout"
    let timeoutRunner = OzonScriptRunner(scriptURL: fixture.script, environment: environment)
    let timedOut = timeoutRunner.execute(.status, timeout: 0.05)
    try expect(timedOut.timedOut, "timeout must be reported")
    try expect(!timedOut.succeeded, "timeout must not be success")

    environment["FAKE_MODE"] = "error"
    let errorRunner = OzonScriptRunner(scriptURL: fixture.script, environment: environment)
    let failed = errorRunner.execute(.status, timeout: 2)
    try expect(failed.exitCode == 7, "non-zero exit must be preserved")
    try expect(failed.bestErrorText.contains("fake control failure"), "stderr should be displayed")
}

private func testMalformedStatus() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    var environment = ProcessInfo.processInfo.environment
    environment["FAKE_COMMAND_LOG"] = fixture.log.path
    environment["FAKE_STATUS_JSON"] = "not-json"
    environment["FAKE_MODE"] = "normal"
    let runner = OzonScriptRunner(scriptURL: fixture.script, environment: environment)
    let inspector = OzonLocalInspector(
        stateRoot: fixture.state,
        configURL: fixture.config,
        cdpListURL: URL(string: "http://127.0.0.1:1/json/list")!,
        cdpTimeout: 0.05
    )
    let service = OzonControlService(runner: runner, inspector: inspector)
    do {
        _ = try service.loadSnapshot()
        throw TestFailure.failed("malformed status should fail")
    } catch let error as OzonControlServiceError {
        try expect(error.localizedDescription.contains("JSON"), "malformed status error should be readable")
    }
}

@main
enum OzonControlCoreTests {
    static func main() {
        let tests: [(String, () throws -> Void)] = [
            ("command mapping and parsing", testCommandMappingAndParsing),
            ("button policies", testButtonPolicies),
            ("browser page counting", testBrowserPageCounting),
            ("safe stop waits for released owners", testSafeStopWaitsForReleasedOwners),
            ("safe stop rejects fatal live owners", testSafeStopDoesNotMisreportFatalOwners),
            ("timeout and error", testTimeoutAndError),
            ("malformed status", testMalformedStatus),
        ]
        do {
            for (name, test) in tests {
                try test()
                print("PASS \(name)")
            }
            print("PASS all \(tests.count) Ozon control panel tests")
        } catch {
            fputs("FAIL \(error)\n", stderr)
            exit(1)
        }
    }
}
