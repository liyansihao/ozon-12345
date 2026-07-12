import AppKit
import SwiftUI

struct QuotaCard: View {
    let window: QuotaWindow

    private var color: Color {
        if window.normalizedUsedPercent >= 95 { return .red }
        if window.normalizedUsedPercent >= 80 { return .orange }
        return .green
    }

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle()
                    .stroke(color.opacity(0.18), lineWidth: 7)
                Circle()
                    .trim(from: 0, to: window.remainingPercent / 100)
                    .stroke(color, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(window.remainingPercent.rounded()))%")
                    .font(.headline.monospacedDigit())
            }
            .frame(width: 70, height: 70)

            VStack(alignment: .leading, spacing: 5) {
                Text(window.displayName)
                    .font(.headline)
                Text("已用 \(Int(window.normalizedUsedPercent.rounded()))% · 剩余 \(Int(window.remainingPercent.rounded()))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(resetText(at: context.date))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func resetText(at now: Date) -> String {
        guard window.resetsAt > now else { return "等待额度刷新" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return "重置时间：\(formatter.localizedString(for: window.resetsAt, relativeTo: now))"
    }
}

private struct UnavailableView: View {
    let title: String
    let systemImage: String
    let description: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.title)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

struct MenuBarView: View {
    @ObservedObject var store: QuotaStore
    @ObservedObject var widgetController: DesktopWidgetController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch store.state {
            case .loading:
                ProgressView("读取本机 Codex 额度…")
                    .frame(maxWidth: .infinity)
            case let .available(snapshot, isStale):
                HStack {
                    Text(snapshot.limitName)
                        .font(.headline)
                    Spacer()
                    if isStale {
                        Text("数据可能已过期")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                QuotaCard(window: snapshot.primary)
                Divider()
                QuotaCard(window: snapshot.secondary)
                Text("更新于 \(snapshot.observedAt.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            case let .empty(message):
                UnavailableView(
                    title: message,
                    systemImage: "gauge.with.dots.needle.0percent",
                    description: "请先在 Codex 中运行一次任务"
                )
            case let .failed(message):
                UnavailableView(
                    title: "无法读取额度",
                    systemImage: "exclamationmark.triangle",
                    description: message
                )
            }

            Divider()
            HStack {
                Button("刷新") {
                    Task { await store.refresh() }
                }
                .keyboardShortcut("r")
                Button(widgetController.isVisible ? "隐藏桌面卡片" : "显示桌面卡片") {
                    widgetController.toggle()
                }
                Spacer()
                Button("退出") {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        .padding(16)
        .frame(width: 330)
    }
}
