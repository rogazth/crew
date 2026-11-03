// Crew's menu bar extra. The app starts it with `--data-dir <its userData>`
// and reads what it asks for on stdout; it reads crewd itself, over the same
// WebSocket the window uses.
import AppKit
import SwiftUI

@main
struct CrewMenuBar: App {
    @StateObject private var store: Store

    init() {
        // No Dock icon and no app menu: it lives in the menu bar only.
        NSApplication.shared.setActivationPolicy(.accessory)
        signal(SIGPIPE, SIG_IGN)
        Host.exitWithParent()
        _store = StateObject(wrappedValue: Store(dataDir: dataDirArgument()))
    }

    var body: some Scene {
        MenuBarExtra {
            MenuView(store: store)
        } label: {
            Image(nsImage: StatusIcon.image(dot: !store.waiting.isEmpty))
        }
        .menuBarExtraStyle(.window)
    }
}

private func dataDirArgument() -> URL {
    let args = CommandLine.arguments
    if let at = args.firstIndex(of: "--data-dir"), at + 1 < args.count {
        return URL(fileURLWithPath: args[at + 1], isDirectory: true)
    }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Crew", isDirectory: true)
}

/// The app icon's crew as a menu bar glyph: three bodies with their eyes cut
/// out, and a small dot while something needs attention.
enum StatusIcon {
    private struct Pill {
        let cx: CGFloat, cy: CGFloat, width: CGFloat, height: CGFloat, look: CGFloat
    }

    /// In the icon's units (scripts/icon.mjs, a 1024 box). The two at the sides
    /// sit 15 further out, or they would touch at menu bar size.
    private static let pills = [
        Pill(cx: 307, cy: 512, width: 150, height: 292, look: 22),
        Pill(cx: 717, cy: 512, width: 150, height: 292, look: -22),
        Pill(cx: 512, cy: 512, width: 190, height: 400, look: 0),
    ]
    private static let box = CGRect(x: 232, y: 312, width: 560, height: 400)
    private static let height: CGFloat = 16

    static func image(dot: Bool) -> NSImage {
        let scale = height / box.height
        let glyph = NSSize(width: box.width * scale, height: height)
        let size = NSSize(width: glyph.width + (dot ? 4 : 0), height: height)
        // Drawn when shown: plain, it is a template the menu bar tints; with the
        // dot, the bodies take the menu bar's own colour and the dot keeps Crew's.
        let image = NSImage(size: size, flipped: true) { _ in
            (dot ? NSColor.labelColor : NSColor.black).setFill()
            crew(scale: scale).fill()
            if dot {
                let d: CGFloat = 5
                NSColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).setFill()
                NSBezierPath(ovalIn: NSRect(x: size.width - d, y: 0, width: d, height: d)).fill()
            }
            return true
        }
        image.isTemplate = !dot
        image.accessibilityDescription = "Crew"
        return image
    }

    /// The bodies, and their bean eyes as holes (even-odd), placed as the icon places them.
    private static func crew(scale: CGFloat) -> NSBezierPath {
        let path = NSBezierPath()
        path.windingRule = .evenOdd
        func pill(_ cx: CGFloat, _ cy: CGFloat, _ width: CGFloat, _ height: CGFloat) {
            let rect = NSRect(
                x: (cx - width / 2 - box.minX) * scale, y: (cy - height / 2 - box.minY) * scale,
                width: width * scale, height: height * scale
            )
            path.appendRoundedRect(rect, xRadius: rect.width / 2, yRadius: rect.width / 2)
        }
        for body in pills {
            pill(body.cx, body.cy, body.width, body.height)
            let unit = body.width / 190
            let cx = body.cx + body.look * unit
            let cy = body.cy - body.height / 2 + (body.look != 0 ? 150 : 140) * unit
            let gap = 78 * unit
            pill(cx - gap / 2, cy, 34 * unit, 62 * unit)
            pill(cx + gap / 2, cy, 34 * unit, 62 * unit)
        }
        return path
    }
}
