import SwiftUI

struct DesktopWidgetView: View {
    @ObservedObject var store: QuotaStore
    let onRefresh: () -> Void
    let onHide: () -> Void

    @State private var isHovering = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            DesktopWidgetDragRegion()
                .frame(width: 150, height: 28)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if isHovering {
                controls
                    .transition(.opacity)
            }
        }
        .padding(14)
        .frame(width: 300, height: 150)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovering = hovering
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 7) {
            header
            stateContent
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Codex 额度")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(headerStatus)
                .font(.caption2)
                .foregroundStyle(headerStatusColor)
                .lineLimit(1)
        }
        .padding(.trailing, isHovering ? 74 : 0)
    }

    private var headerStatus: String {
        switch store.state {
        case .loading: return "更新中…"
        case let .available(_, isStale):
            return DesktopWidgetPresentation.headerStatus(isStale: isStale)
        case .empty: return "暂无数据"
        case .failed: return "读取失败"
        }
    }

    private var headerStatusColor: Color {
        switch store.state {
        case let .available(_, isStale) where isStale: return .orange
        case .failed: return .red
        default: return .secondary
        }
    }

    @ViewBuilder
    private var stateContent: some View {
        switch store.state {
        case .loading:
            CompactStatusView(
                title: "正在读取…",
                systemImage: "gauge.with.dots.needle.50percent"
            )

        case let .available(snapshot, _):
            TimelineView(.periodic(from: .now, by: 30)) { context in
                HStack(spacing: 22) {
                    CompactQuotaRing(window: snapshot.primary, now: context.date)
                    CompactQuotaRing(window: snapshot.secondary, now: context.date)
                }
                .frame(maxWidth: .infinity)
            }

        case let .empty(message):
            CompactStatusView(
                title: message,
                subtitle: "请先在 Codex 中运行一次任务",
                systemImage: "gauge.with.dots.needle.0percent"
            )

        case .failed:
            CompactStatusView(
                title: "无法读取额度",
                subtitle: "悬停后可重试",
                systemImage: "exclamationmark.triangle"
            )
        }
    }

    private var controls: some View {
        HStack(spacing: 5) {
            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
            }
            .help("刷新")

            Button(action: onHide) {
                Image(systemName: "xmark")
            }
            .help("隐藏桌面卡片")
        }
        .buttonStyle(.borderless)
        .font(.caption.weight(.semibold))
        .padding(5)
        .background(.regularMaterial, in: Capsule())
    }
}

private struct CompactQuotaRing: View {
    let window: QuotaWindow
    let now: Date

    private var color: Color {
        if window.normalizedUsedPercent >= 95 { return .red }
        if window.normalizedUsedPercent >= 80 { return .orange }
        return .green
    }

    var body: some View {
        VStack(spacing: 3) {
            ZStack {
                Circle()
                    .stroke(color.opacity(0.18), lineWidth: 6)
                Circle()
                    .trim(from: 0, to: window.remainingPercent / 100)
                    .stroke(color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(window.remainingPercent.rounded()))%")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
            }
            .frame(width: 64, height: 64)

            Text(window.displayName)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(DesktopWidgetPresentation.resetCountdown(resetsAt: window.resetsAt, now: now))
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: 112)
    }
}

enum DesktopWidgetPresentation {
    static func headerStatus(isStale: Bool) -> String {
        isStale ? "数据可能已过期" : "已更新"
    }

    static func resetCountdown(resetsAt: Date, now: Date) -> String {
        let remaining = resetsAt.timeIntervalSince(now)
        guard remaining > 0 else { return "等待额度刷新" }

        let totalMinutes = Int(remaining / 60)
        guard totalMinutes > 0 else { return "不足1分钟后重置" }

        let days = totalMinutes / (24 * 60)
        let hours = totalMinutes % (24 * 60) / 60
        let minutes = totalMinutes % 60
        if days > 0 {
            return hours > 0 ? "\(days)天\(hours)小时后重置" : "\(days)天后重置"
        }
        if hours > 0 {
            return minutes > 0 ? "\(hours)小时\(minutes)分钟后重置" : "\(hours)小时后重置"
        }
        return "\(minutes)分钟后重置"
    }
}

private struct DesktopWidgetDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> DesktopWidgetDragRegionView {
        DesktopWidgetDragRegionView()
    }

    func updateNSView(_ nsView: DesktopWidgetDragRegionView, context: Context) {}
}

private struct CompactStatusView: View {
    let title: String
    var subtitle: String? = nil
    let systemImage: String

    var body: some View {
        VStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
                .lineLimit(1)
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .multilineTextAlignment(.center)
    }
}
