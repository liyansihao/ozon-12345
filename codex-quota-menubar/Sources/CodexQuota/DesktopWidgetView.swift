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
        switch store.state {
        case .loading:
            CompactStatusView(
                title: "读取 Codex 额度…",
                systemImage: "gauge.with.dots.needle.50percent"
            )

        case let .available(snapshot, isStale):
            VStack(spacing: 9) {
                HStack(spacing: 8) {
                    Text(snapshot.limitName)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 36)
                    if isStale {
                        Text("数据已过期")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }

                HStack(spacing: 32) {
                    CompactQuotaRing(window: snapshot.primary)
                    CompactQuotaRing(window: snapshot.secondary)
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

    private var color: Color {
        if window.normalizedUsedPercent >= 95 { return .red }
        if window.normalizedUsedPercent >= 80 { return .orange }
        return .green
    }

    var body: some View {
        VStack(spacing: 5) {
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
        }
    }
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
