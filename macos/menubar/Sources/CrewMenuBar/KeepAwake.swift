// Keeps the Mac from idle sleep, as `caffeinate -i` does. The assertion lives
// with this process: when the helper exits, macOS lets the Mac sleep again.
// Closing the lid still sleeps it, unless it is on power with a display attached.
import Foundation
import IOKit.pwr_mgt

final class KeepAwake {
    private var assertion: IOPMAssertionID = 0
    private var held = false

    func hold(_ on: Bool) {
        if on == held { return }
        if on {
            let reason = "Crew is keeping the Mac awake for its sessions" as CFString
            held = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), reason, &assertion
            ) == kIOReturnSuccess
        } else {
            IOPMAssertionRelease(assertion)
            held = false
        }
    }
}

/// What the menu remembers, in the data dir beside the database: each build its own.
struct MenuPrefs: Codable {
    var awake = false

    static func load(_ dataDir: URL) -> MenuPrefs {
        guard let data = try? Data(contentsOf: file(dataDir)),
              let prefs = try? JSONDecoder().decode(MenuPrefs.self, from: data) else { return MenuPrefs() }
        return prefs
    }

    func save(_ dataDir: URL) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        try? data.write(to: Self.file(dataDir), options: .atomic)
    }

    private static func file(_ dataDir: URL) -> URL { dataDir.appendingPathComponent("menubar.json") }
}
