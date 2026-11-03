// The pace math of `src/lib/usageData.ts`, for one plan window: what is left,
// where an even spend would stand, and when it runs out at this pace.
import Foundation

/// Points either side of the even pace that still count as on it.
let onPace = 2.0

struct Pace {
    /// Where the share used would stand had the window been spent evenly so far, 0‥100.
    let expected: Double
    /// Points left in hand: under that even line (positive) or over it (negative).
    let reserve: Double
    /// Minutes until it is spent at this pace; nil when it lasts until the reset.
    let runsOutIn: Double?
}

extension UsageWindow {
    /// Share used, 0‥100, rounded as the app shows it.
    var used: Double { min(100, max(0, usedPercent.rounded())) }

    /// Minutes until it resets; nil when the provider does not say.
    var resetsIn: Double? {
        guard let resetsAt else { return nil }
        return max(0, (resetsAt - Date().timeIntervalSince1970 * 1000) / 60_000)
    }

    var pace: Pace? {
        guard let length = windowMinutes, let resetsIn, length > 0 else { return nil }
        let elapsed = min(length, max(0, length - resetsIn))
        let expected = elapsed / length * 100
        var out: Double?
        if elapsed > 0, used > 0 {
            let left = (100 - used) * elapsed / used
            if left < resetsIn { out = left }
        }
        return Pace(expected: expected, reserve: expected - used, runsOutIn: out)
    }
}

/// `2d 3h`, `4h 10m`, `12m`, as the rail writes a span.
func span(_ minutes: Double) -> String {
    if minutes >= 1440 {
        let d = Int(minutes / 1440)
        let h = Int(((minutes.truncatingRemainder(dividingBy: 1440)) / 60).rounded())
        return h > 0 ? "\(d)d \(h)h" : "\(d)d"
    }
    if minutes >= 60 {
        let h = Int(minutes / 60)
        let m = Int(minutes.truncatingRemainder(dividingBy: 60).rounded())
        return m > 0 ? "\(h)h \(m)m" : "\(h)h"
    }
    return "\(max(1, Int(minutes.rounded())))m"
}

let providerNames = ["claude": "Claude", "codex": "Codex", "cursor": "Cursor", "opencode": "OpenCode", "grok": "Grok"]

func providerName(_ provider: String) -> String {
    providerNames[provider] ?? provider.prefix(1).uppercased() + provider.dropFirst()
}
