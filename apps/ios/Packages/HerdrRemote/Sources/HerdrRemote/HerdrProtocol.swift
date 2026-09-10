import Foundation

public enum HerdrRemoteError: Error, LocalizedError {
    case invalidConfiguration, hostKeyMismatch, authentication, disconnected, commandFailed
    case oversized, invalidFrame, continuityGap
    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration: return "Check the SSH host, port, username, host public key, and session."
        case .hostKeyMismatch: return "The SSH host key does not match. Verify it on the host before reconnecting."
        case .authentication: return "SSH authentication failed. This mode requires password authentication."
        case .disconnected: return "SSH disconnected. Reconnect to get a fresh terminal checkpoint."
        case .commandFailed: return "Herdr could not attach. Check its executable path, running session, and terminal-control support."
        case .oversized: return "The stream exceeded the memory limit. Reconnect to resynchronize."
        case .invalidFrame: return "Herdr returned an unsupported terminal frame."
        case .continuityGap: return "Terminal continuity was lost. Reconnect to resynchronize."
        }
    }
}

public struct HerdrSSHConfiguration: Sendable {
    public let host: String
    public let port: Int
    public let username: String
    public let password: String
    public let hostPublicKey: String
    public let session: String
    public let executable: String

    public init(host: String, port: Int, username: String, password: String,
                hostPublicKey: String, session: String, executable: String = "herdr") throws {
        guard !host.isEmpty, host.count <= 253, !host.contains(where: { $0.isWhitespace }),
              (1...65535).contains(port), !username.isEmpty, username.count <= 128,
              !password.isEmpty, !session.isEmpty, session.utf8.count <= 128,
              !hostPublicKey.isEmpty, hostPublicKey.utf8.count <= 8192,
              !executable.isEmpty, executable.utf8.count <= 1024,
              ![host, username, password, session, executable].contains(where: { $0.contains("\0") }) else {
            throw HerdrRemoteError.invalidConfiguration
        }
        self.host = host; self.port = port; self.username = username; self.password = password
        self.hostPublicKey = hostPublicKey; self.session = session; self.executable = executable
    }

    // SSH exec requests are interpreted by a remote shell. Only these fixed Herdr
    // operations exist; every value is POSIX-quoted, including the executable.
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    var snapshotCommand: String { command(["api", "snapshot"]) }
    func controlCommand(pane: String, cols: Int, rows: Int) -> String {
        command(["terminal", "session", "control", pane, "--cols", String(cols), "--rows", String(rows)])
    }
    private func command(_ args: [String]) -> String {
        ([executable, "--session", session] + args).map(Self.quote).joined(separator: " ")
    }
}

public struct HerdrSnapshot: Decodable, Sendable {
    public let workspaces: [Workspace]
    public let tabs: [Tab]
    public let panes: [Pane]
    public struct Workspace: Decodable, Identifiable, Sendable {
        public let workspace_id: String
        public let label: String
        public let number: Int
        public let agent_status: String?
        public var id: String { workspace_id }
    }
    public struct Tab: Decodable, Identifiable, Sendable {
        public let tab_id: String
        public let workspace_id: String
        public let label: String
        public let number: Int
        public let agent_status: String?
        public var id: String { tab_id }
    }
    public struct Pane: Decodable, Identifiable, Sendable {
        public let pane_id: String
        public let tab_id: String
        public let terminal_title_stripped: String?
        public let agent_status: String?
        public var id: String { pane_id }
    }
    struct Envelope: Decodable {
        let result: Result
        struct Result: Decodable { let snapshot: HerdrSnapshot }
    }
    static func decode(_ data: Data) throws -> HerdrSnapshot {
        guard data.count <= 4 * 1024 * 1024 else { throw HerdrRemoteError.oversized }
        return try JSONDecoder().decode(Envelope.self, from: data).result.snapshot
    }
}

/// Each SSH attach starts a new sequence domain. A full frame must precede diffs;
/// missing, duplicated or reordered diffs close the stream rather than hiding a gap.
public struct HerdrFrameDecoder {
    private var pending = Data()
    private var sequence: UInt64?
    public private(set) var closed = false
    public init() {}
    public mutating func append(_ data: Data) throws -> [Data] {
        guard !closed else { throw HerdrRemoteError.disconnected }
        guard pending.count + data.count <= 2 * 1024 * 1024 else { throw HerdrRemoteError.oversized }
        pending.append(data)
        var frames: [Data] = []
        while let newline = pending.firstIndex(of: 10) {
            let line = Data(pending[..<newline])
            pending.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            let record = try JSONDecoder().decode(Record.self, from: line)
            if record.type == "terminal.closed" {
                closed = true
                pending.removeAll(keepingCapacity: false)
                break // Deliver preceding frames even when close arrives in the same SSH chunk.
            }
            guard record.type == "terminal.frame", record.encoding == "ansi",
                  let seq = record.seq, let full = record.full,
                  let encoded = record.bytes, let bytes = Data(base64Encoded: encoded) else {
                throw HerdrRemoteError.invalidFrame
            }
            guard bytes.count <= 1024 * 1024 else { throw HerdrRemoteError.oversized }
            if !full {
                guard let previous = sequence, previous < UInt64.max, seq == previous + 1 else {
                    throw HerdrRemoteError.continuityGap
                }
            }
            sequence = seq
            // RIS clears any previous display when accepting a full checkpoint.
            frames.append(full ? Data([0x1b, 0x63]) + bytes : bytes)
        }
        return frames
    }
    private struct Record: Decodable {
        let type: String
        let encoding: String?
        let seq: UInt64?
        let full: Bool?
        let bytes: String?
    }
}
