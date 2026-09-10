import Foundation
import WebKit

@MainActor
final class TerminalStore: ObservableObject {
    @Published var projects: [TerminalProject] = []
    @Published var error: String?
    @Published var signedIn = false
    @Published var live = false
    @Published var busy = false
    @Published private(set) var server: URL?
    let websiteData = WKWebsiteDataStore.nonPersistent()
    private let session: URLSession
    private var statusTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        session = URLSession(configuration: configuration)
        if let saved = UserDefaults.standard.string(forKey: "server") {
            server = try? Self.serverURL(saved)
        }
    }

    static func serverURL(_ text: String) throws -> URL {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw ConnectionError.invalidServer }
        parts.path = ""
        guard let url = parts.url else { throw ConnectionError.invalidServer }
        return url
    }

    func configure(_ text: String) async throws {
        let next = try Self.serverURL(text)
        if server != next { await disconnect() }
        server = next
        UserDefaults.standard.set(next.absoluteString, forKey: "server")
    }

    func request(_ path: String) throws -> URLRequest {
        guard let server else { throw ConnectionError.invalidServer }
        var request = URLRequest(url: server.appendingPathComponent(path))
        request.setValue(server.absoluteString, forHTTPHeaderField: "Origin")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    func signIn(password: String) async throws {
        if !password.isEmpty {
            var request = try request("api/auth/password")
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(["password": password])
            let (_, response) = try await session.data(for: request)
            try validate(response)
        }
        try await loadProjects()
        for cookie in session.configuration.httpCookieStorage?.cookies ?? [] {
            await websiteData.httpCookieStore.setCookie(cookie)
        }
    }

    private func validate(_ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse else { throw ConnectionError.response(0) }
        if response.statusCode == 401 || response.statusCode == 403 { throw ConnectionError.signIn }
        guard (200..<300).contains(response.statusCode) else {
            throw ConnectionError.response(response.statusCode)
        }
    }

    private func loadProjects() async throws {
        let origin = server
        let (data, response) = try await session.data(for: request("api/projects"))
        try Task.checkCancellation()
        guard server == origin else { throw CancellationError() }
        try validate(response)
        projects = try JSONDecoder().decode([TerminalProject].self, from: data)
        signedIn = true
        error = nil
    }

    func refresh() async {
        do { try await loadProjects() }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }

    func resume() {
        guard signedIn, statusTask == nil else { return }
        statusTask = Task { [weak self] in
            guard let self else { return }
            var failures = 0
            while !Task.isCancelled {
                do {
                    var request = try self.request("api/ws/status")
                    var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    parts.scheme = "wss"
                    request.url = parts.url
                    let socket = self.session.webSocketTask(with: request)
                    socket.maximumMessageSize = 4 * 1024 * 1024
                    self.socket = socket
                    socket.resume()
                    try await socket.send(.string("{\"type\":\"subscribe-devices\"}"))
                    // Subscribe before reconciling so structural changes cannot be missed.
                    try await self.loadProjects()
                    self.live = true
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        failures = 0
                        let data: Data
                        switch message {
                        case .string(let value): data = Data(value.utf8)
                        case .data(let value): data = value
                        @unknown default: continue
                        }
                        let update = try JSONDecoder().decode(InventoryMessage.self, from: data)
                        if update.type == "refresh" { try await self.loadProjects() }
                        if update.type == "inventory-patch" { self.apply(update) }
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    self.live = false
                    self.error = error.localizedDescription
                    self.socket?.cancel(with: .goingAway, reason: nil)
                    failures = min(failures + 1, 5)
                    let delay = min(15.0, pow(2.0, Double(failures)) * 0.5)
                    try? await Task.sleep(for: .seconds(delay * Double.random(in: 0.5...1)))
                }
            }
        }
    }

    func suspend() {
        statusTask?.cancel()
        statusTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        live = false
    }

    func disconnect() async {
        suspend()
        signedIn = false
        projects = []
        error = nil
        session.configuration.httpCookieStorage?.removeCookies(since: .distantPast)
        await websiteData.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    private func apply(_ message: InventoryMessage) {
        guard let updates = message.projects, updates.count <= 512,
              updates.reduce(0, { $0 + ($1.tabs?.count ?? 0) }) <= 4096 else { return }
        for update in updates {
            guard let index = projects.firstIndex(where: { $0.id == update.id }) else { continue }
            if let status = update.status { projects[index].status = status }
            if let focused = update.runtimeFocused { projects[index].runtimeFocused = focused }
            for tab in update.tabs ?? [] {
                guard let slot = projects[index].tabs.firstIndex(where: { $0.id == tab.id }) else { continue }
                if let status = tab.status {
                    projects[index].tabs[slot].status = status
                    projects[index].tabs[slot].session?.status = status
                }
                if let status = tab.runtimeTabStatus { projects[index].tabs[slot].runtimeTabStatus = status }
                if let focused = tab.focused { projects[index].tabs[slot].focused = focused }
            }
        }
    }
}
