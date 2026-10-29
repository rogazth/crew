// One WebSocket to this Mac's crewd, spoken the way the window speaks it: the
// address and token come from `<data-dir>/daemon.json`, read again on every
// reconnect, since a restarted daemon takes a new port and token.
import AppKit
import Foundation

struct DaemonFile: Decodable {
    let url: String
    let token: String
}

enum LinkError: Error {
    case down
    case refused(String)
}

@MainActor
final class DaemonLink {
    /// The daemon said hello: the link is up and requests go through.
    var onOnline: (() -> Void)?
    var onOffline: (() -> Void)?
    var onEvent: ((String) -> Void)?

    private let dataDir: URL
    private let session = URLSession(configuration: .ephemeral)
    private var task: URLSessionWebSocketTask?
    private var online = false
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var delay: TimeInterval = 0.25
    private var retry: Task<Void, Never>?
    private var ping: Task<Void, Never>?

    init(dataDir: URL) {
        self.dataDir = dataDir
        // A Mac that slept kept a socket nobody answers on.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconnect() }
        }
    }

    func connect() {
        guard task == nil else { return }
        retry?.cancel()
        retry = nil
        guard let file = readFile(), let url = URL(string: file.url) else {
            schedule()
            return
        }
        let ws = session.webSocketTask(with: url)
        task = ws
        ws.resume()
        send(ws, ["auth": file.token])
        receive(ws)
    }

    func reconnect() {
        delay = 0.25
        drop(task)
        connect()
    }

    /// `method` with `params`, answered with the result's JSON.
    func request(_ method: String, _ params: [String: Any] = [:]) async throws -> Data {
        guard online, let ws = task else { throw LinkError.down }
        let id = nextId
        nextId += 1
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            send(ws, ["id": id, "method": method, "params": params])
        }
    }

    func request<T: Decodable>(_ method: String, _ params: [String: Any] = [:], as type: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request(method, params))
    }

    private func readFile() -> DaemonFile? {
        guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("daemon.json")) else { return nil }
        return try? JSONDecoder().decode(DaemonFile.self, from: data)
    }

    private func send(_ ws: URLSessionWebSocketTask, _ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        ws.send(.string(text)) { _ in }
    }

    private func receive(_ ws: URLSessionWebSocketTask) {
        ws.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === ws else { return }
                switch result {
                case .failure:
                    self.drop(ws)
                    self.schedule()
                case .success(let message):
                    if case .string(let text) = message { self.handle(text) }
                    self.receive(ws)
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let event = message["event"] as? String {
            if event == "hello", !online {
                online = true
                delay = 0.25
                armPing()
                onOnline?()
            }
            onEvent?(event)
            return
        }
        guard let id = message["id"] as? Int, let waiter = pending.removeValue(forKey: id) else { return }
        if message["ok"] as? Bool == true {
            let result = message["result"] ?? NSNull()
            let json = (try? JSONSerialization.data(withJSONObject: result, options: .fragmentsAllowed)) ?? Data("null".utf8)
            waiter.resume(returning: json)
        } else {
            waiter.resume(throwing: LinkError.refused(message["error"] as? String ?? "Request failed"))
        }
    }

    /// A WebSocket ping every 15 s: a daemon that stopped answering reads as gone.
    private func armPing() {
        ping?.cancel()
        ping = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, let ws = self.task else { return }
                ws.sendPing { error in
                    guard error != nil else { return }
                    Task { @MainActor [weak self] in
                        guard let self, self.task === ws else { return }
                        self.drop(ws)
                        self.schedule()
                    }
                }
            }
        }
    }

    private func drop(_ ws: URLSessionWebSocketTask?) {
        guard let ws, task === ws else { return }
        ws.cancel(with: .goingAway, reason: nil)
        task = nil
        ping?.cancel()
        ping = nil
        for waiter in pending.values { waiter.resume(throwing: LinkError.down) }
        pending.removeAll()
        if online {
            online = false
            onOffline?()
        }
    }

    private func schedule() {
        guard retry == nil else { return }
        let wait = delay
        delay = min(delay * 2, 10)
        retry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.retry = nil
            self.connect()
        }
    }
}
