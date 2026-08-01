import AppKit
import Combine
import SwiftUI

@MainActor
final class OzonPanelViewModel: ObservableObject {
    @Published private(set) var snapshot: OzonDashboardSnapshot?
    @Published private(set) var isBusy = false
    @Published private(set) var actionMessage: String?
    @Published private(set) var lastError: String?

    private let service: OzonControlService
    private var pendingRefresh = false

    init(service: OzonControlService) {
        self.service = service
    }

    convenience init() {
        let paths = OzonProductionPaths.make()
        let runner = OzonScriptRunner(scriptURL: paths.script)
        let inspector = OzonLocalInspector(
            stateRoot: paths.stateRoot,
            configURL: paths.config,
            cdpListURL: paths.cdpList
        )
        self.init(service: OzonControlService(runner: runner, inspector: inspector))
    }

    var policy: OzonButtonPolicy {
        guard let status = snapshot?.production.status else {
            return OzonButtonPolicy(canStart: false, canStop: false, canResumeVerification: false)
        }
        return OzonButtonPolicy.forStatus(status, owners: snapshot?.production.owners ?? OzonOwners())
    }

    func refresh() {
        guard !isBusy else {
            pendingRefresh = true
            return
        }
        isBusy = true
        actionMessage = "正在刷新状态…"
        service.refresh { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isBusy = false
                self.apply(result, successMessage: nil)
                self.runPendingRefreshIfNeeded()
            }
        }
    }

    func perform(_ command: OzonControlCommand) {
        guard !isBusy else { return }
        isBusy = true
        lastError = nil
        switch command {
        case .start:
            actionMessage = "正在启动并继续原 run…"
        case .stop:
            actionMessage = "正在请求安全暂停并等待状态落盘…"
        case .resume:
            actionMessage = "正在提交验证完成信号…"
        case .status:
            actionMessage = "正在刷新状态…"
        }

        service.perform(command) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isBusy = false
                let successMessage: String
                switch command {
                case .start:
                    successMessage = "启动请求已接受，系统正在继续原 run。"
                case .stop:
                    successMessage = "生产任务已安全暂停并完成状态落盘。"
                case .resume:
                    successMessage = "恢复请求已接受，系统正在继续原 run。"
                case .status:
                    successMessage = "状态已刷新。"
                }
                self.apply(result, successMessage: successMessage)
                self.runPendingRefreshIfNeeded()
            }
        }
    }

    private func apply(_ result: Result<OzonDashboardSnapshot, Error>, successMessage: String?) {
        switch result {
        case .success(let newSnapshot):
            snapshot = newSnapshot
            lastError = nil
            actionMessage = successMessage
        case .failure(let error):
            lastError = error.localizedDescription
            actionMessage = nil
        }
    }

    private func runPendingRefreshIfNeeded() {
        guard pendingRefresh else { return }
        pendingRefresh = false
        refresh()
    }
}

struct OzonControlPanelView: View {
    @ObservedObject var model: OzonPanelViewModel
    @State private var showStopConfirmation = false
    private let refreshTimer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 18) {
            header
            progressCard
            runtimeCard
            messageArea
            controls
        }
        .padding(24)
        .frame(width: 620, height: 590)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            NSApp.activate(ignoringOtherApps: true)
            model.refresh()
        }
        .onReceive(refreshTimer) { _ in
            model.refresh()
        }
        .alert("确认安全暂停？", isPresented: $showStopConfirmation) {
            Button("取消", role: .cancel) {}
            Button("安全暂停", role: .destructive) {
                model.perform(.stop)
            }
        } message: {
            Text("系统会调用现有 stop 入口，在状态机边界停止并等待状态落盘。不会清空 run、登录信息或去重数据。")
        }
    }

    private var production: OzonProductionStatus? { model.snapshot?.production }

    private var header: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(statusColor.opacity(0.16))
                    .frame(width: 48, height: 48)
                Image(systemName: statusIcon)
                    .font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(statusColor)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Ozon 上品控制")
                    .font(.title2.weight(.bold))
                Text(statusTitle)
                    .font(.headline)
                    .foregroundStyle(statusColor)
            }
            Spacer()
            if model.isBusy {
                ProgressView()
                    .controlSize(.small)
            }
            VStack(alignment: .trailing, spacing: 3) {
                Text(production?.status ?? "尚未读取")
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(refreshText)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var progressCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("ERP 已接受")
                    .font(.headline)
                Spacer()
                Text("\(production?.accepted ?? 0)")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                Text("/ \(production?.target ?? 500)")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            ProgressView(value: progressValue)
                .tint(statusColor)
            HStack {
                metric(title: "剩余", value: "\(production?.remainingCount ?? 500)")
                Divider().frame(height: 32)
                metric(title: "后台在线", value: "\(production?.online ?? 0)")
                Divider().frame(height: 32)
                metric(title: "当前店铺", value: model.snapshot?.local.currentStore.displayName ?? "—")
            }
        }
        .padding(16)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var runtimeCard: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            GridRow {
                runtimeLabel("Supervisor")
                runtimeValue("\(production?.owners.supervisor ?? 0)")
                runtimeLabel("Worker")
                runtimeValue("\(production?.owners.worker ?? 0)")
            }
            Divider().gridCellColumns(4)
            GridRow {
                runtimeLabel("Browser owner")
                runtimeValue("\(production?.owners.profile ?? 0)")
                runtimeLabel("浏览器标签页")
                runtimeValue(tabCountText)
            }
            Divider().gridCellColumns(4)
            GridRow {
                runtimeLabel("Run")
                Text(production?.runID ?? "—")
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .textSelection(.enabled)
                    .gridCellColumns(3)
            }
        }
        .padding(16)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private var messageArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            if production?.status == "WAITING_FOR_VERIFICATION" {
                Label("请在系统保留的 Chrome 中手工完成验证码、MFA 或登录检查，再点“验证后恢复”。", systemImage: "person.badge.key")
                    .foregroundStyle(.orange)
            }
            if let reason = production?.reason, !reason.isEmpty {
                Label("状态说明：\(reason)", systemImage: "exclamationmark.circle")
                    .foregroundStyle(statusColor)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
            if let runtimeError = model.snapshot?.local.lastRuntimeError {
                Label("最后错误：\(runtimeError.displayText)", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .lineLimit(3)
                    .help(runtimeError.at ?? "最近一条 runtime_errors.jsonl 记录")
                    .textSelection(.enabled)
            }
            if let error = model.lastError {
                Label("面板错误：\(error)", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red)
                    .lineLimit(3)
                    .textSelection(.enabled)
            } else if let message = model.actionMessage {
                Label(message, systemImage: model.isBusy ? "clock" : "checkmark.circle")
                    .foregroundStyle(model.isBusy ? Color.secondary : Color.green)
                    .lineLimit(2)
            }
            if model.snapshot?.local.lastRuntimeError == nil, model.lastError == nil, model.actionMessage == nil {
                Text("最后错误：无")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .topLeading)
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button {
                model.perform(.start)
            } label: {
                Label("启动/继续", systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.isBusy || !model.policy.canStart)

            Button {
                showStopConfirmation = true
            } label: {
                Label("安全暂停", systemImage: "pause.fill")
            }
            .buttonStyle(.bordered)
            .disabled(model.isBusy || !model.policy.canStop)

            Button {
                model.refresh()
            } label: {
                Label("刷新状态", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)

            Button {
                model.perform(.resume)
            } label: {
                Label("验证后恢复", systemImage: "person.badge.key.fill")
            }
            .buttonStyle(.bordered)
            .disabled(model.isBusy || !model.policy.canResumeVerification)
        }
        .controlSize(.large)
    }

    private var progressValue: Double {
        guard let production else { return 0 }
        return min(1, max(0, Double(production.accepted) / Double(max(1, production.target))))
    }

    private var tabCountText: String {
        guard let count = model.snapshot?.local.browserTabCount else { return "—" }
        return "\(count)"
    }

    private var refreshText: String {
        guard let date = model.snapshot?.refreshedAt else { return "每 5 秒自动刷新" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "HH:mm:ss 更新"
        return formatter.string(from: date)
    }

    private var statusTitle: String {
        switch production?.status {
        case "RUNNING": return "正在直接上架"
        case "STOPPED":
            let owners = production?.owners ?? OzonOwners()
            return owners == OzonOwners() ? "已安全暂停" : "正在安全收尾"
        case "WAITING_FOR_VERIFICATION": return "等待人工验证"
        case "TARGET_COMPLETE": return "本轮目标已完成"
        case "FATAL_STOP": return "已因严重错误停止"
        case "STARTING": return "正在启动"
        case "RECOVERING": return "正在自动恢复"
        case "WAITING_FOR_QUOTA_RESET": return "等待额度恢复"
        case .some(let value): return value
        case .none: return "正在读取生产状态"
        }
    }

    private var statusIcon: String {
        switch production?.status {
        case "RUNNING": return "arrow.up.circle.fill"
        case "STOPPED": return "pause.circle.fill"
        case "WAITING_FOR_VERIFICATION": return "person.badge.key.fill"
        case "TARGET_COMPLETE": return "checkmark.seal.fill"
        case "FATAL_STOP": return "xmark.octagon.fill"
        case "STARTING", "RECOVERING": return "arrow.triangle.2.circlepath.circle.fill"
        default: return "circle.dashed"
        }
    }

    private var statusColor: Color {
        switch production?.status {
        case "RUNNING": return .green
        case "STOPPED": return .secondary
        case "WAITING_FOR_VERIFICATION", "WAITING_FOR_QUOTA_RESET": return .orange
        case "TARGET_COMPLETE": return .blue
        case "FATAL_STOP": return .red
        case "STARTING", "RECOVERING": return .cyan
        default: return .secondary
        }
    }

    private var cardBackground: Color {
        Color(nsColor: .controlBackgroundColor)
    }

    private func metric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.headline).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func runtimeLabel(_ value: String) -> some View {
        Text(value)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func runtimeValue(_ value: String) -> some View {
        Text(value)
            .font(.system(.body, design: .monospaced).weight(.semibold))
    }
}

struct OzonControlPanelApp: App {
    @StateObject private var model = OzonPanelViewModel()

    var body: some Scene {
        WindowGroup("Ozon 上品控制") {
            OzonControlPanelView(model: model)
        }
        .windowResizability(.contentSize)
    }
}

@main
enum OzonControlPanelEntryPoint {
    static func main() {
        if CommandLine.arguments.dropFirst().first == "--status-once" {
            runReadOnlyStatusProbe()
            return
        }
        OzonControlPanelApp.main()
    }

    private static func runReadOnlyStatusProbe() {
        let paths = OzonProductionPaths.make()
        let service = OzonControlService(
            runner: OzonScriptRunner(scriptURL: paths.script),
            inspector: OzonLocalInspector(
                stateRoot: paths.stateRoot,
                configURL: paths.config,
                cdpListURL: paths.cdpList
            )
        )
        do {
            let snapshot = try service.loadSnapshot()
            let payload: [String: Any] = [
                "status": snapshot.production.status,
                "accepted": snapshot.production.accepted,
                "target": snapshot.production.target,
                "remaining": snapshot.production.remainingCount,
                "online": snapshot.production.online,
                "current_store": snapshot.local.currentStore.displayName,
                "supervisor": snapshot.production.owners.supervisor,
                "worker": snapshot.production.owners.worker,
                "browser_owner": snapshot.production.owners.profile,
                "browser_tabs": snapshot.local.browserTabCount ?? NSNull(),
                "last_error": snapshot.local.lastRuntimeError?.displayText ?? NSNull(),
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }
}
