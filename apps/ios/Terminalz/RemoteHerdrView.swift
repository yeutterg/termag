import SwiftUI
import SwiftTerm
import HerdrRemote

@MainActor
final class RemoteHerdrStore: ObservableObject {
    @Published var inventory: HerdrSnapshot?
    @Published var error: String?
    @Published var busy = false
    @Published private(set) var connection: HerdrSSH?
    private(set) var configuration: HerdrSSHConfiguration?
    private var revision = UUID()

    func connect(_ configuration: HerdrSSHConfiguration) async throws {
        let revision = self.revision
        let connection = try await HerdrSSH.connect(configuration)
        do {
            let snapshot = try await connection.snapshot()
            try Task.checkCancellation()
            guard revision == self.revision else { throw CancellationError() }
            self.connection = connection
            self.configuration = configuration
            inventory = snapshot
            error = nil
        } catch {
            await connection.close()
            throw error
        }
    }
    func refresh() async {
        guard let connection else { return }
        do { inventory = try await connection.snapshot(); error = nil }
        catch { self.error = error.localizedDescription }
    }
    func suspend() {
        revision = UUID()
        let old = connection
        connection = nil
        Task { await old?.close() }
    }
    func disconnect() {
        suspend()
        configuration = nil
        inventory = nil
    }
    func resume() async {
        guard connection == nil, let configuration else { return }
        do { try await connect(configuration) }
        catch { self.error = error.localizedDescription }
    }
}

struct RemoteHerdrView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = RemoteHerdrStore()
    @State private var host = ""
    @State private var port = "22"
    @State private var username = ""
    @State private var password = ""
    @State private var publicKey = ""
    @State private var session = "default"
    @State private var executable = "herdr"
    @State private var selected: String?
    @State private var generation = UUID()

    var body: some View {
        Group {
            if let inventory = store.inventory {
                NavigationSplitView {
                    List(selection: $selected) {
                        ForEach(inventory.workspaces.sorted { $0.number < $1.number }) { workspace in
                            ForEach(inventory.tabs.filter { $0.workspace_id == workspace.id }.sorted { $0.number < $1.number }) { tab in
                                Section("\(workspace.label) · \(tab.label)") {
                                    ForEach(inventory.panes.filter { $0.tab_id == tab.id }) { pane in
                                        NavigationLink(value: pane.id) {
                                            HStack {
                                                StatusGlyph(status: pane.agent_status ?? "unknown", symbols: false)
                                                Text(pane.terminal_title_stripped.flatMap { $0.isEmpty ? nil : $0 } ?? pane.id)
                                            }.frame(minHeight: 44)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .navigationTitle(store.configuration?.host ?? "Herdr")
                    .navigationBarTitleDisplayMode(.inline)
                    .refreshable { await store.refresh() }
                    .toolbar { Button("Disconnect") { store.disconnect(); dismiss() } }
                    .safeAreaInset(edge: .bottom) {
                        VStack(spacing: 4) {
                            Text("Session: \(store.configuration?.session ?? "default")").font(.caption)
                            if let error = store.error { Text(error).font(.footnote) }
                        }.foregroundStyle(.secondary).padding(8)
                    }
                } detail: {
                    if let selected, inventory.panes.contains(where: { $0.id == selected }),
                       let connection = store.connection, scenePhase == .active {
                        HerdrTerminalView(connection: connection, pane: selected)
                            .id("\(selected):\(generation)")
                            .navigationTitle("Herdr")
                            .navigationBarTitleDisplayMode(.inline)
                            .toolbar {
                                Button("Reconnect", systemImage: "arrow.clockwise") {
                                    store.suspend()
                                    Task { await store.resume(); generation = UUID() }
                                }
                            }
                    } else {
                        ContentUnavailableView {
                            Label("Select a pane", systemImage: "terminal")
                        } description: {
                            Text("Choose a pane from the sidebar, or reconnect if the host is unavailable.")
                        } actions: {
                            if store.connection == nil {
                                Button("Reconnect") { Task { await store.resume(); generation = UUID() } }
                            }
                        }
                    }
                }
            } else {
                NavigationStack {
                    Form {
                        Section("SSH connection") {
                            TextField("Host", text: $host).keyboardType(.URL)
                            TextField("Port", text: $port).keyboardType(.numberPad)
                            TextField("Username", text: $username).textContentType(.username)
                            SecureField("SSH password", text: $password).textContentType(.password)
                        }
                        Section {
                            TextField("ssh-ed25519 AAAA…", text: $publicKey, axis: .vertical)
                                .font(.system(.footnote, design: .monospaced))
                        } header: { Text("Verified host public key") } footer: {
                            Text("Copy the host’s SSH public key from a trusted source, such as /etc/ssh/ssh_host_ed25519_key.pub on that machine. Never enter its private key.")
                        }
                        Section("Herdr") {
                            TextField("Session", text: $session)
                            TextField("Executable path", text: $executable)
                        }
                        Section {
                            Button {
                                store.busy = true
                                Task {
                                    defer { store.busy = false }
                                    do {
                                        let configuration = try HerdrSSHConfiguration(host: host.trimmingCharacters(in: .whitespaces),
                                            port: Int(port) ?? 0, username: username, password: password,
                                            hostPublicKey: publicKey.trimmingCharacters(in: .whitespacesAndNewlines),
                                            session: session, executable: executable)
                                        try await store.connect(configuration)
                                        password = ""
                                    } catch { store.error = error.localizedDescription }
                                }
                            } label: {
                                HStack { Text("Connect"); Spacer(); if store.busy { ProgressView() } }.frame(minHeight: 44)
                            }.disabled(store.busy)
                        } footer: {
                            Text("Connects to an already-running Herdr session, like a direct remote attach. Requires SSH password authentication and Herdr terminal session control. No Terminalz server is needed. Credentials remain in memory.")
                        }
                        if let error = store.error { Section { Text(error).foregroundStyle(.red) } }
                    }
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .navigationTitle("Direct Herdr")
                    .toolbar { Button("Cancel") { store.disconnect(); dismiss() } }
                }
            }
        }
        .preferredColorScheme(.dark)
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { store.suspend() }
        }
        .task(id: scenePhase) {
            if scenePhase == .active { await store.resume(); generation = UUID() }
        }
        .onDisappear { store.disconnect() }
    }
}

private struct HerdrTerminalView: UIViewRepresentable {
    let connection: HerdrSSH
    let pane: String
    func makeCoordinator() -> Coordinator { Coordinator(connection: connection, pane: pane) }
    func makeUIView(context: Context) -> TerminalView {
        var options = TerminalOptions()
        options.scrollback = 500
        options.kittyImageCacheLimitBytes = 1024 * 1024
        options.enableSixelReported = false
        let view = TerminalView(frame: .zero, font: .monospacedSystemFont(ofSize: 14, weight: .regular), options: options)
        view.getTerminal().silentLog = true // Also suppress parser diagnostics in Debug builds.
        view.nativeBackgroundColor = .black
        view.nativeForegroundColor = .white
        view.isUserInteractionEnabled = false
        view.terminalDelegate = context.coordinator
        context.coordinator.start(view)
        return view
    }
    func updateUIView(_ view: TerminalView, context: Context) { }
    static func dismantleUIView(_ view: TerminalView, coordinator: Coordinator) {
        view.terminalDelegate = nil
        coordinator.stop()
    }

    @MainActor
    final class Coordinator: NSObject, TerminalViewDelegate {
        let connection: HerdrSSH
        let pane: String
        var stream: HerdrTerminalStream?
        var task: Task<Void, Never>?
        var resizeTask: Task<Void, Never>?
        var writes: Task<Void, Never>?
        var pendingInput = 0
        var cols = 80
        var rows = 24
        init(connection: HerdrSSH, pane: String) { self.connection = connection; self.pane = pane }
        func start(_ view: TerminalView) {
            task = Task { [weak self, weak view] in
                guard let self else { return }
                do {
                    let stream = try await connection.control(pane: pane, cols: cols, rows: rows)
                    guard !Task.isCancelled else { stream.close(); return }
                    self.stream = stream
                    view?.isUserInteractionEnabled = true
                    defer { stream.close(); self.stream = nil }
                    try await stream.resize(cols: cols, rows: rows)
                    var decoder = HerdrFrameDecoder()
                    for try await data in stream.output {
                        try Task.checkCancellation()
                        for bytes in try decoder.append(data) { view?.feed(byteArray: Array(bytes)[...]) }
                        if decoder.closed { break }
                    }
                    if !Task.isCancelled {
                        view?.isUserInteractionEnabled = false
                        view?.feed(text: "\r\n[Disconnected — tap Reconnect]\r\n")
                    }
                } catch {
                    if !Task.isCancelled {
                        view?.isUserInteractionEnabled = false
                        // Never interpolate remote error payloads into a terminal or log.
                        view?.feed(text: "\r\n[Unable to continue this Herdr stream. Check the session and tap Reconnect.]\r\n")
                    }
                }
            }
        }
        func stop() { task?.cancel(); resizeTask?.cancel(); writes?.cancel(); stream?.close(); stream = nil }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            cols = newCols; rows = newRows
            resizeTask?.cancel()
            resizeTask = Task {
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled else { return }
                do { try await stream?.resize(cols: cols, rows: rows) }
                catch { stop() }
            }
        }
        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            guard let stream else { return }
            guard pendingInput + data.count <= 256 * 1024 else {
                stop(); source.feed(text: "\r\n[Input limit reached — reconnect]\r\n"); return
            }
            let bytes = Data(data)
            pendingInput += bytes.count
            let previous = writes
            writes = Task { [weak self] in
                await previous?.value
                guard let self else { return }
                defer { pendingInput -= bytes.count }
                guard !Task.isCancelled else { return }
                do {
                    for offset in stride(from: 0, to: bytes.count, by: 32 * 1024) {
                        try Task.checkCancellation()
                        try await stream.input(bytes.subdata(in: offset..<min(bytes.count, offset + 32 * 1024)))
                    }
                } catch { stop() }
            }
        }
        func setTerminalTitle(source: TerminalView, title: String) { }
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) { }
        func scrolled(source: TerminalView, position: Double) { }
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), ["https", "http"].contains(url.scheme) else { return }
            UIApplication.shared.open(url)
        }
        func bell(source: TerminalView) { }
        func clipboardCopy(source: TerminalView, content: Data) { }
        func clipboardRead(source: TerminalView) -> Data? { nil }
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) { }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) { }
    }
}
