// What the menu shows, read from crewd: the sessions waiting on the user (as
// the Dock badge counts them) and the plan usage of the providers with a ring
// on the rail, in the rail's order. It also holds the
// Mac awake while the user asks it to.
import Foundation

struct Workspace: Decodable {
    let id: String
    let name: String
}

struct SessionRow: Decodable, Identifiable {
    let id: String
    let workspaceId: String
    let name: String
    let provider: String
    let status: String
    let notifications: Bool
}

struct UsageWindow: Decodable, Identifiable {
    let id: String
    let label: String
    let usedPercent: Double
    let windowMinutes: Double?
    let resetsAt: Double?
}

struct PlanUsage: Decodable {
    let provider: String
    let account: String?
    let windows: [UsageWindow]
    let updatedAt: Double
}

struct UsageSnapshot: Decodable {
    let readings: [PlanUsage]
}

struct Waiting: Identifiable {
    let session: SessionRow
    let workspace: String
    var id: String { session.id }
}

/// A session in one of these is waiting on the user: to answer it, or to read what it did.
private let attention: Set<String> = ["needs-input", "done", "error"]
/// Which providers have a ring on the rail, as the window saves it (`usage:rings`).
struct RingConfig: Decodable {
    let order: [String]
    let shown: [String]
}

/// The providers that report a plan, in the order a fresh setup shows them.
private let plans = ["claude", "codex", "cursor", "grok"]
/// The rail fits three rings at most.
private let maxRings = 3

@MainActor
final class Store: ObservableObject {
    @Published private(set) var online = false
    @Published private(set) var waiting: [Waiting] = []
    @Published private(set) var usage: [PlanUsage] = []
    @Published var awake: Bool {
        didSet {
            prefs.awake = awake
            prefs.save(dataDir)
            keepAwake.hold(awake)
        }
    }

    private let dataDir: URL
    private let link: DaemonLink
    private let keepAwake = KeepAwake()
    private var prefs: MenuPrefs
    private var readings: [PlanUsage] = []
    /// The rail's rings, outermost first; a fresh setup's until the saved one is read.
    private var rings = Array(plans.prefix(maxRings))
    private var sessionsDue: Task<Void, Never>?
    private var sweep: Task<Void, Never>?

    init(dataDir: URL) {
        self.dataDir = dataDir
        link = DaemonLink(dataDir: dataDir)
        prefs = MenuPrefs.load(dataDir)
        awake = prefs.awake
        link.onOnline = { [weak self] in self?.cameOnline() }
        link.onOffline = { [weak self] in self?.online = false }
        link.onEvent = { [weak self] event in self?.heard(event) }
        keepAwake.hold(awake)
        link.connect()
    }

    private func cameOnline() {
        online = true
        refreshSessions()
        Task {
            await readRings()
            await readUsage()
        }
        // Statuses an event missed while nothing was listening still come right.
        sweep?.cancel()
        sweep = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                self?.refreshSessions()
            }
        }
    }

    private func heard(_ event: String) {
        switch event {
        case "session-status", "session-updated", "sessions-deleted": refreshSessions()
        case "usage-changed": Task { await readUsage() }
        default: break
        }
    }

    /// Events come in bursts during a turn: one read for each burst.
    private func refreshSessions() {
        sessionsDue?.cancel()
        sessionsDue = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await self?.readSessions()
        }
    }

    private func readSessions() async {
        guard let workspaces = try? await link.request("workspace_list", as: [Workspace].self) else { return }
        var rows: [Waiting] = []
        for workspace in workspaces {
            guard let sessions = try? await link.request(
                "session_list", ["workspaceId": workspace.id], as: [SessionRow].self
            ) else { continue }
            for session in sessions where session.notifications && attention.contains(session.status) {
                rows.append(Waiting(session: session, workspace: workspace.name))
            }
        }
        waiting = rows.sorted { rank($0.session.status) < rank($1.session.status) }
    }

    private func readUsage() async {
        guard let snapshot = try? await link.request("usage_read", as: UsageSnapshot.self) else { return }
        // One reading per provider and account, the latest one.
        var latest: [String: PlanUsage] = [:]
        for reading in snapshot.readings where !reading.windows.isEmpty {
            let key = "\(reading.provider)|\(reading.account ?? "")"
            if let seen = latest[key], seen.updatedAt >= reading.updatedAt { continue }
            latest[key] = reading
        }
        readings = Array(latest.values)
        showUsage()
    }

    /// The rings are saved without an event, so the menu reads them each time it opens.
    func readRings() async {
        guard let raw = try? await link.request("state_get", ["key": "usage:rings"], as: String?.self),
              let data = raw.data(using: .utf8),
              let config = try? JSONDecoder().decode(RingConfig.self, from: data) else { return }
        rings = Array(config.order.filter { plans.contains($0) && config.shown.contains($0) }.prefix(maxRings))
        showUsage()
    }

    private func showUsage() {
        usage = readings
            .filter { rings.contains($0.provider) }
            .sorted { rings.firstIndex(of: $0.provider)! < rings.firstIndex(of: $1.provider)! }
    }

    private func rank(_ status: String) -> Int {
        switch status {
        case "needs-input": 0
        case "error": 1
        default: 2
        }
    }
}
