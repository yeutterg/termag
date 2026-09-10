import Foundation

struct TerminalSession: Decodable {
    let id: String
    var status: String
}

struct TerminalTab: Decodable, Identifiable {
    let id: String
    let name: String
    var status: String
    let runtimeTabId: String?
    let runtimeTabName: String?
    let layout: String?
    var runtimeTabStatus: String?
    var focused: Bool?
    var session: TerminalSession?
}

struct TerminalProject: Decodable, Identifiable {
    let id: String
    let name: String
    let rootKey: String
    let deviceId: String
    let runtime: String
    let runtimeSessionId: String
    let runtimeSessionName: String
    let runtimeIconStyle: String?
    var status: String
    var runtimeFocused: Bool
    var tabs: [TerminalTab]

    var sectionID: String { "\(deviceId)/\(runtime)/\(runtimeSessionId)" }
    var sectionTitle: String { "\(rootKey) · \(runtimeSessionName) (\(runtime))" }
    var nativeTabs: [TerminalTab] {
        var seen = Set<String>()
        return tabs.filter { seen.insert($0.runtimeTabId ?? $0.id).inserted }
    }
}

struct InventoryMessage: Decodable {
    let type: String
    var projects: [ProjectPatch]?
    struct ProjectPatch: Decodable {
        let id: String
        let status: String?
        let runtimeFocused: Bool?
        let tabs: [TabPatch]?
    }
    struct TabPatch: Decodable {
        let id: String
        let status: String?
        let runtimeTabStatus: String?
        let focused: Bool?
    }
}

enum ConnectionError: LocalizedError {
    case invalidServer, signIn, response(Int)
    var errorDescription: String? {
        switch self {
        case .invalidServer: return "Enter an HTTPS server address, without a path or credentials."
        case .signIn: return "Sign in to this server to continue."
        case .response(let code): return "The server returned HTTP \(code)."
        }
    }
}
