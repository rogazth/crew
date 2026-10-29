// The menu's window: what needs attention, the providers' usage, and a switch
// that keeps the Mac awake. On macOS 26 the system draws it in Liquid Glass.
import AppKit
import SwiftUI

struct MenuView: View {
    @ObservedObject var store: Store

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !store.online {
                Text("Crew is not running")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                Divider()
            }
            if !store.waiting.isEmpty {
                Section(title: "Needs attention") {
                    ForEach(store.waiting) { WaitingRow(item: $0) }
                }
                Divider()
            }
            if !store.usage.isEmpty {
                Section(title: "Usage") {
                    ForEach(store.usage, id: \.provider) { UsageBlock(reading: $0) }
                }
                Divider()
            }
            HStack {
                Text("Keep awake")
                Spacer()
                Toggle("Keep awake", isOn: $store.awake)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .labelsHidden()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .frame(width: 300)
        .onAppear { Task { await store.readRings() } }
    }
}

private struct Section<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
            content
        }
        .padding(.vertical, 10)
    }
}

private struct WaitingRow: View {
    let item: Waiting
    @State private var hovered = false

    var body: some View {
        Button {
            Host.open(item.session)
        } label: {
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 6, height: 6)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.session.name.isEmpty ? "Untitled" : item.session.name)
                        .lineLimit(1)
                    Text(item.workspace)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovered ? Color.primary.opacity(0.08) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .padding(.horizontal, 6)
    }

    private var label: String {
        switch item.session.status {
        case "needs-input": "Needs input"
        case "error": "Error"
        default: "Done"
        }
    }

    private var color: Color {
        switch item.session.status {
        case "needs-input": .orange
        case "error": .red
        default: .green
        }
    }
}

private struct UsageBlock: View {
    let reading: PlanUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(providerName(reading.provider))
                .font(.callout.weight(.medium))
            ForEach(reading.windows) { WindowRow(window: $0) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
    }
}

/// One plan window, as the rail's card draws it: what is left, the reset, a bar
/// with a tick where an even pace would stand, and how the spend compares.
private struct WindowRow: View {
    let window: UsageWindow

    var body: some View {
        let left = 100 - window.used
        let pace = window.used >= 100 ? nil : window.pace
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text("\(Int(left))% left").font(.caption.weight(.semibold)).monospacedDigit()
                Text(window.label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 4)
                if let resetsIn = window.resetsIn {
                    Text("Resets in \(span(resetsIn))").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            PaceBar(left: left, pace: pace, fill: fill)
            PaceLine(window: window, pace: pace)
        }
    }

    /// Neutral until the window is nearly spent.
    private var fill: Color {
        window.used >= 90 ? .red : Color.primary.opacity(0.45)
    }
}

private struct PaceBar: View {
    let left: Double
    let pace: Pace?
    let fill: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.1)).frame(height: 4)
                Capsule().fill(fill).frame(width: geo.size.width * left / 100, height: 4)
                if let pace {
                    let x = min(max(geo.size.width * (100 - pace.expected) / 100, 1.5), geo.size.width - 1.5)
                    Capsule()
                        .fill(Color.primary.opacity(0.85))
                        .frame(width: 2, height: 9)
                        .offset(x: x - 1)
                }
            }
            .frame(height: 10)
        }
        .frame(height: 10)
    }
}

private struct PaceLine: View {
    let window: UsageWindow
    let pace: Pace?

    var body: some View {
        if window.used >= 100 {
            Text("Limit reached").font(.caption2).foregroundStyle(.red)
        } else if let pace, pace.expected >= 3 {
            let points = Int(abs(pace.reserve).rounded())
            let lead =
                pace.reserve >= onPace ? "\(points)% in reserve"
                : pace.reserve > -onPace ? "On pace"
                : "\(points)% over pace"
            Text(lead + " · " + (pace.runsOutIn.map { "Runs out in \(span($0))" } ?? "Lasts until reset"))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }
}
