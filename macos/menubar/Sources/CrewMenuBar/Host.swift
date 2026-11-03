// The line to the app that started this helper: one JSON object per line on
// stdout asks it for something, and stdin closing means it is gone.
import AppKit
import Foundation

enum Host {
    /// Brings Crew's window up on the session.
    static func open(_ session: SessionRow) {
        write(["open": ["workspaceId": session.workspaceId, "sessionId": session.id]])
    }

    /// The app quits, crashes or is killed: its helper goes with it.
    static func exitWithParent() {
        Thread.detachNewThread {
            while FileHandle.standardInput.availableData.count > 0 {}
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private static func write(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        // write(2), not FileHandle: a closed pipe is an error to ignore, not an exception.
        data.withUnsafeBytes { _ = Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
    }
}
