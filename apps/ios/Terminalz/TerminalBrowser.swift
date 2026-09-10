import SwiftUI

struct TerminalBrowser: View {
    @EnvironmentObject private var store: TerminalStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var projectID: String?
    @State private var tabID: String?
    @State private var settings = false

    private var project: TerminalProject? { store.projects.first { $0.id == projectID } }
    private var tab: TerminalTab? { project?.tabs.first { $0.id == tabID } }
    private var sections: [String] {
        var seen = Set<String>()
        return store.projects.map(\.sectionID).filter { seen.insert($0).inserted }
    }

    var body: some View {
        Group {
            if !store.signedIn {
                ConnectionView()
            } else {
                NavigationSplitView {
                    List(selection: $projectID) {
                        ForEach(sections, id: \.self) { section in
                            let projects = store.projects.filter { $0.sectionID == section }
                            Section(projects.first?.sectionTitle ?? "") {
                                ForEach(projects) { project in
                                    NavigationLink(value: project.id) {
                                        HStack {
                                            StatusGlyph(status: project.status, symbols: project.runtimeIconStyle == "symbols")
                                            Text(project.name)
                                            Spacer()
                                            if project.runtimeFocused {
                                                Image(systemName: "location.fill").font(.caption).foregroundStyle(.secondary)
                                                    .accessibilityLabel("Focused")
                                            }
                                        }.frame(minHeight: 44)
                                    }
                                }
                            }
                        }
                    }
                    .overlay {
                        if store.projects.isEmpty {
                            ContentUnavailableView("No terminals", systemImage: "terminal", description: Text("Open a Herdr or tmux session on a connected machine, then refresh."))
                        }
                    }
                    .navigationTitle("Terminalz")
                    .refreshable { await store.refresh() }
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Settings", systemImage: "gearshape") { settings = true }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Image(systemName: store.live ? "network" : "wifi.slash")
                                .foregroundStyle(store.live ? Color.green : Color.secondary)
                                .accessibilityLabel(store.live ? "Connected" : "Reconnecting")
                        }
                    }
                    .safeAreaInset(edge: .bottom) {
                        if let error = store.error {
                            Text(error).font(.footnote).foregroundStyle(.secondary).padding()
                        }
                    }
                } content: {
                    List(selection: $tabID) {
                        ForEach(project?.nativeTabs ?? []) { tab in
                            NavigationLink(value: tab.id) {
                                HStack {
                                    StatusGlyph(status: tab.runtimeTabStatus ?? tab.status, symbols: project?.runtimeIconStyle == "symbols")
                                    Text(tab.runtimeTabName ?? tab.name)
                                }.frame(minHeight: 44)
                            }
                            .disabled(tab.session == nil)
                        }
                    }
                    .navigationTitle(project?.name ?? "Tabs")
                    .overlay {
                        if project == nil { ContentUnavailableView("Select a space", systemImage: "sidebar.left") }
                    }
                } detail: {
                    if let project, let tab, tab.session != nil, let server = store.server {
                        TerminalDetail(server: server, project: project, tab: tab)
                            .id(tab.id)
                    } else {
                        ContentUnavailableView("Select a terminal", systemImage: "terminal", description: Text("Your machines. Your sessions."))
                    }
                }
                .sheet(isPresented: $settings) {
                    NavigationStack {
                        Form {
                            Section("Server") { Text(store.server?.absoluteString ?? "") }
                            Section {
                                Text("Dark appearance · Low data streaming").foregroundStyle(.secondary)
                                Text("Only the current terminal is loaded. Sessions and terminal output stay in memory.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            Button("Disconnect", role: .destructive) {
                                settings = false
                                projectID = nil
                                tabID = nil
                                Task { await store.disconnect() }
                            }
                        }
                        .navigationTitle("Settings")
                        .toolbar { Button("Done") { settings = false } }
                    }.presentationDetents([.medium, .large])
                }
            }
        }
        .onChange(of: projectID) { _, _ in tabID = nil }
        .onChange(of: store.signedIn) { _, signedIn in
            if signedIn && scenePhase == .active { store.resume() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.resume() } else { store.suspend() }
        }
    }
}

struct StatusGlyph: View {
    let status: String
    let symbols: Bool
    private var appearance: (String, Color, String) {
        switch status {
        case "blocked": return (symbols ? "◉" : "●", .red, "Blocked")
        case "working": return (symbols ? "⠋" : "●", .orange, "Working")
        case "done": return ("●", .teal, "Done")
        case "idle": return (symbols ? "✓" : "○", .green, "Idle")
        case "offline": return ("·", .secondary, "Offline")
        default: return (symbols ? "○" : "·", .secondary, "Unknown")
        }
    }
    var body: some View {
        Text(appearance.0).font(.system(.body, design: .monospaced))
            .foregroundStyle(appearance.1).frame(width: 20).accessibilityLabel(appearance.2)
    }
}

struct ConnectionView: View {
    @EnvironmentObject private var store: TerminalStore
    @State private var address = ""
    @State private var password = ""
    @State private var directHerdr = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Your terminals, wherever you are.", systemImage: "terminal")
                        .font(.headline).padding(.vertical, 12)
                }
                Section("Server") {
                    TextField("https://terminalz.example.com", text: $address)
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password (if required)", text: $password)
                        .textContentType(.password)
                }
                Section {
                    Button {
                        store.busy = true
                        Task {
                            defer { store.busy = false }
                            do {
                                try await store.configure(address)
                                try await store.signIn(password: password)
                                password = ""
                            } catch { store.error = error.localizedDescription }
                        }
                    } label: {
                        HStack {
                            Text("Connect")
                            Spacer()
                            if store.busy { ProgressView() }
                        }.frame(minHeight: 44)
                    }
                } footer: {
                    Text("Connect to a password or trusted-network server. OAuth servers are not supported yet. Only the address is saved; sign in again after closing the app.")
                }
                if let error = store.error {
                    Section { Text(error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
                }
                Section {
                    Button("Connect directly to Herdr over SSH", systemImage: "network") { directHerdr = true }
                        .frame(minHeight: 44)
                }
            }
            .disabled(store.busy)
            .navigationTitle("Terminalz")
            .onAppear { address = store.server?.absoluteString ?? "" }
            .fullScreenCover(isPresented: $directHerdr) { RemoteHerdrView() }
        }
    }
}
