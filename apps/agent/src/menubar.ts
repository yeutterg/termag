import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentConfig, loadConfig } from "./config";

type StartMacMenuBarOptions = {
  tag: string;
  agentVersion?: string;
  deviceName?: string;
};

let activeMenuBar: ChildProcess | null = null;

const MAC_PATH = [
  process.env.PATH,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]
  .filter(Boolean)
  .join(":");

export function startMacMenuBar(opts: StartMacMenuBarOptions): ChildProcess | null {
  if (process.platform !== "darwin") {
    return null;
  }
  if (process.env.TERMAG_AGENT_FAKE === "true") {
    return null;
  }
  const config = loadConfig();
  if (!menuBarEnabled(config)) {
    return null;
  }
  if (activeMenuBar && !activeMenuBar.killed) {
    return activeMenuBar;
  }

  const tmuxPath = resolveCommand("tmux");
  if (!tmuxPath) {
    console.warn(`[${opts.tag}] mac menu bar disabled: tmux not found.`);
    return null;
  }

  const scriptPath = writeMenuBarScript();
  const helperPath = compileMenuBarHelper(scriptPath, opts.tag);
  if (!helperPath) {
    return null;
  }

  const child = spawn(
    helperPath,
    [
      String(process.pid),
      tmuxPath,
      terminalApp(config),
      opts.agentVersion ?? "",
      opts.deviceName ?? "",
    ],
    {
      detached: false,
      stdio: "ignore",
      env: { ...process.env, PATH: MAC_PATH },
    }
  );

  activeMenuBar = child;
  child.unref();

  let startupWindow = true;
  setTimeout(() => {
    startupWindow = false;
  }, 3000).unref();
  child.on("error", err => {
    if (activeMenuBar === child) {
      activeMenuBar = null;
    }
    console.warn(`[${opts.tag}] mac menu bar could not start: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    if (activeMenuBar === child) {
      activeMenuBar = null;
    }
    if (startupWindow && code !== 0 && signal !== "SIGTERM") {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      console.warn(`[${opts.tag}] mac menu bar exited during startup (${reason}).`);
    }
  });

  return child;
}

export function stopMacMenuBar() {
  if (!activeMenuBar) {
    return;
  }
  try {
    activeMenuBar.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  activeMenuBar = null;
}

function menuBarEnabled(config: AgentConfig) {
  if (process.env.TERMAG_NO_MENUBAR === "true") {
    return false;
  }
  if (process.env.TERMAG_MAC_MENUBAR === "false") {
    return false;
  }
  if (process.env.TERMAG_MAC_MENUBAR === "true") {
    return true;
  }
  if (typeof config.menuBar?.enabled === "boolean") {
    return config.menuBar.enabled;
  }
  if (typeof config.macMenuBar === "boolean") {
    return config.macMenuBar;
  }
  return false;
}

function terminalApp(config: AgentConfig) {
  return (
    process.env.TERMAG_TERMINAL_APP?.trim() ||
    config.menuBar?.terminalApp?.trim() ||
    config.terminalApp?.trim() ||
    terminalAppFromTermProgram() ||
    "Terminal"
  );
}

function terminalAppFromTermProgram() {
  const value = process.env.TERM_PROGRAM?.toLowerCase();
  if (value === "apple_terminal") {
    return "Terminal";
  }
  if (value === "iterm.app" || value === "iterm2") {
    return "iTerm2";
  }
  if (value === "ghostty") {
    return "Ghostty";
  }
  return "";
}

function resolveCommand(command: "swiftc" | "tmux"): string | null {
  const knownPath = command === "swiftc" ? "/usr/bin/swiftc" : "";
  if (knownPath && existsSync(knownPath)) {
    return knownPath;
  }

  try {
    const stdout = execFileSync("/bin/sh", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: MAC_PATH },
      timeout: 2000,
    }).trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function expandHome(value: string) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function writeMenuBarScript() {
  const dir = path.join(os.homedir(), ".termag");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(dir, "termag-menubar.swift");
  writeFileSync(scriptPath, MAC_MENU_BAR_SWIFT, { mode: 0o600 });
  return scriptPath;
}

function compileMenuBarHelper(scriptPath: string, tag: string): string | null {
  const swiftcPath = resolveCommand("swiftc");
  if (!swiftcPath) {
    console.warn(
      `[${tag}] mac menu bar disabled: swiftc not found. Install Xcode Command Line Tools, or set TERMAG_MAC_MENUBAR=false.`
    );
    return null;
  }

  const helperPath = path.join(os.homedir(), ".termag", "termag-menubar");
  try {
    const scriptStat = statSync(scriptPath);
    const helperStat = existsSync(helperPath) ? statSync(helperPath) : null;
    if (!helperStat || helperStat.mtimeMs < scriptStat.mtimeMs) {
      execFileSync(swiftcPath, [scriptPath, "-o", helperPath], {
        env: { ...process.env, PATH: MAC_PATH },
        timeout: 60_000,
      });
    }
    return helperPath;
  } catch (err) {
    console.warn(
      `[${tag}] mac menu bar disabled: could not compile helper: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

const MAC_MENU_BAR_SWIFT = String.raw`
import Cocoa
import Darwin
import Foundation

let commandArgs = CommandLine.arguments
let parentPid = commandArgs.count > 1 ? pid_t(Int32(commandArgs[1]) ?? 0) : pid_t(0)
let tmuxPath = commandArgs.count > 2 ? commandArgs[2] : "/usr/bin/tmux"
let requestedTerminalApp = commandArgs.count > 3 ? commandArgs[3] : "Terminal"
let agentVersion = commandArgs.count > 4 ? commandArgs[4] : ""
let agentDeviceName = commandArgs.count > 5 ? commandArgs[5] : ""

// Agent status tracking
struct AgentStatus: Codable {
    let connected: Bool
    let brokerUrl: String
    let currentProject: String?
    let currentBranch: String?
    let activeSessions: Int
}

func readAgentStatus() -> AgentStatus? {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser
    let statusFile = homeDir.appendingPathComponent(".termag").appendingPathComponent("agent-status.json")
    
    guard let data = try? Data(contentsOf: statusFile),
          let status = try? JSONDecoder().decode(AgentStatus.self, from: data) else {
        return nil
    }
    return status
}

func connectionStatusEmoji() -> String {
    guard let status = readAgentStatus() else {
        return "🔴"
    }
    return status.connected ? "🟢" : "🟡"
}

// Italic ASCII banner + compact context block shown at the top of every
// fresh shell tmux pane the menu helper spawns. Matches the TS
// apps/agent/src/banner.ts output so the experience is the same whether
// the session was created from the browser, the CLI, or the menu bar.
enum TermagBanner {
    private static let art: String = {
        // Backticks are written as \u{0060} so the TypeScript host file can
        // embed this Swift source inside a String.raw template literal
        // without closing it prematurely.
        let bt = "\u{0060}"
        return [
            "  _                                 ",
            " | |_ ___ _ __ _ __ ___   __ _  __ _",
            " | __/ _ \\ '__| '_ \(bt) _ \\ / _\(bt) |/ _\(bt) |",
            " | ||  __/ |  | | | | | | (_| | (_| |",
            "  \\__\\___|_|  |_| |_| |_|\\__,_|\\__, |",
            "                                |___/"
        ].joined(separator: "\n")
    }()

    static func render(version: String, deviceName: String, cwd: String, shell: String) -> String {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? ""
        var displayCwd = cwd
        if !home.isEmpty {
            if cwd == home {
                displayCwd = "~"
            } else if cwd.hasPrefix(home + "/") {
                displayCwd = "~/" + String(cwd.dropFirst(home.count + 1))
            }
        }
        let shellLabel: String = {
            let trimmed = shell.trimmingCharacters(in: .whitespacesAndNewlines)
            let head = trimmed.split(separator: " ", maxSplits: 1).first.map(String.init) ?? trimmed
            return head.split(separator: "/").last.map(String.init) ?? head
        }()
        var headerParts: [String] = []
        if !version.isEmpty { headerParts.append("termag \(version)") }
        // Menu-bar sessions are ad-hoc — no project to display, just device.
        if !deviceName.isEmpty { headerParts.append(deviceName) }
        if !shellLabel.isEmpty { headerParts.append(shellLabel) }
        let header = "\u{001B}[3m\(art)\u{001B}[0m"
        if headerParts.isEmpty && displayCwd.isEmpty {
            return "\(header)\n\n"
        }
        var lines: [String] = []
        if !headerParts.isEmpty { lines.append(headerParts.joined(separator: " · ")) }
        if !displayCwd.isEmpty { lines.append(displayCwd) }
        return "\(header)\n\u{001B}[2m\(lines.joined(separator: "\n"))\u{001B}[0m\n\n"
    }
}

struct AppleScriptResult {
    let ok: Bool
    let status: Int32
    let output: String
}

struct TmuxWindow {
    let index: String
    let name: String
}

struct TmuxSession {
    let name: String
    let path: String
    let windowCount: String
    let clientCount: Int
    let windows: [TmuxWindow]
}

final class TermagStatusController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var parentTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        if let button = statusItem.button {
            if #available(macOS 11.0, *) {
                if let image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Termag") {
                    image.isTemplate = true
                    button.image = image
                } else {
                    button.title = "T"
                }
            } else {
                button.title = "T"
            }
        }

        menu.autoenablesItems = false
        menu.delegate = self
        statusItem.menu = menu

        if parentPid > 0 {
            parentTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
                if Darwin.kill(parentPid, 0) != 0 {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        let statusEmoji = connectionStatusEmoji()
        let statusText = statusEmoji + " Termag"
        
        let title = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        // Show project and branch if available
        if let status = readAgentStatus() {
            var contextParts: [String] = []
            if let project = status.currentProject {
                contextParts.append("Project: \(project)")
            }
            if let branch = status.currentBranch {
                contextParts.append("Branch: \(branch)")
            }
            if status.activeSessions > 0 {
                contextParts.append("\(status.activeSessions) session\(status.activeSessions == 1 ? "" : "s")")
            }
            
            if !contextParts.isEmpty {
                let contextItem = NSMenuItem(title: contextParts.joined(separator: " · "), action: nil, keyEquivalent: "")
                contextItem.isEnabled = false
                menu.addItem(contextItem)
            }
        }

        menu.addItem(NSMenuItem.separator())

        // Quick Git Actions
        if let status = readAgentStatus(), status.connected {
            let gitStatusItem = NSMenuItem(title: "Git Status", action: #selector(gitStatus(_:)), keyEquivalent: "g")
            gitStatusItem.target = self
            gitStatusItem.isEnabled = true
            menu.addItem(gitStatusItem)

            let gitPullItem = NSMenuItem(title: "Git Pull", action: #selector(gitPull(_:)), keyEquivalent: "p")
            gitPullItem.target = self
            gitPullItem.isEnabled = true
            menu.addItem(gitPullItem)

            let gitPushItem = NSMenuItem(title: "Git Push", action: #selector(gitPush(_:)), keyEquivalent: "u")
            gitPushItem.target = self
            gitPushItem.isEnabled = true
            menu.addItem(gitPushItem)
        }

        menu.addItem(NSMenuItem.separator())

        let create = NSMenuItem(title: "New tmux Session...", action: #selector(createSession(_:)), keyEquivalent: "n")
        create.target = self
        create.isEnabled = true
        menu.addItem(create)

        menu.addItem(NSMenuItem.separator())

        let sessions = listSessions()
        if sessions.isEmpty {
            let empty = NSMenuItem(title: "No tmux sessions", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for session in sessions {
                menu.addItem(sessionMenuItem(session))
            }
        }

        menu.addItem(NSMenuItem.separator())

        let refresh = NSMenuItem(title: "Refresh", action: #selector(refreshMenu(_:)), keyEquivalent: "r")
        refresh.target = self
        refresh.isEnabled = true
        menu.addItem(refresh)

        let quit = NSMenuItem(title: "Quit Termag", action: #selector(quitTermag(_:)), keyEquivalent: "q")
        quit.target = self
        quit.isEnabled = true
        menu.addItem(quit)
    }

    private func sessionMenuItem(_ session: TmuxSession) -> NSMenuItem {
        let suffix = session.windowCount == "1" ? "window" : "windows"
        let item = NSMenuItem(title: "\(sessionStatusEmoji(session)) \(session.name) (\(session.windowCount) \(suffix))", action: nil, keyEquivalent: "")
        let submenu = NSMenu()

        if !session.path.isEmpty {
            let pathItem = NSMenuItem(title: session.path, action: nil, keyEquivalent: "")
            pathItem.isEnabled = false
            submenu.addItem(pathItem)
            submenu.addItem(NSMenuItem.separator())
        }

        let attachItem = NSMenuItem(title: "Focus or Attach", action: #selector(focusOrAttachSession(_:)), keyEquivalent: "")
        attachItem.target = self
        attachItem.representedObject = session.name
        attachItem.isEnabled = true
        submenu.addItem(attachItem)
        submenu.addItem(NSMenuItem.separator())

        if session.windows.isEmpty {
            let empty = NSMenuItem(title: "No windows", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            submenu.addItem(empty)
        } else {
            for window in session.windows {
                let windowItem = NSMenuItem(title: "\(window.index): \(window.name)", action: nil, keyEquivalent: "")
                windowItem.isEnabled = false
                submenu.addItem(windowItem)
            }
        }

        submenu.addItem(NSMenuItem.separator())
        let killItem = NSMenuItem(title: "Kill Session…", action: #selector(killSession(_:)), keyEquivalent: "")
        killItem.target = self
        killItem.representedObject = session.name
        killItem.isEnabled = true
        // Render the kill action in a destructive red on macOS 14+.
        if #available(macOS 14.0, *) {
            let title = NSMutableAttributedString(string: "Kill Session…")
            title.addAttribute(.foregroundColor, value: NSColor.systemRed, range: NSRange(location: 0, length: title.length))
            killItem.attributedTitle = title
        }
        submenu.addItem(killItem)

        item.submenu = submenu
        return item
    }

    private func sessionStatusEmoji(_ session: TmuxSession) -> String {
        session.clientCount > 0 ? "🟢" : "🟡"
    }

    @objc private func refreshMenu(_ sender: NSMenuItem) {
        rebuildMenu()
    }

    @objc private func focusOrAttachSession(_ sender: NSMenuItem) {
        guard let sessionName = sender.representedObject as? String else {
            return
        }
        // Re-validate at click time. The menu's session list is a snapshot
        // taken on menuNeedsUpdate; short-lived sessions (Claude Code
        // wrappers, etc.) often die between snapshot and click. Without this
        // we would open a Terminal tab that immediately fails with "can't
        // find session".
        if !tmuxSessionExists(sessionName) {
            rebuildMenu()
            showAlert(
                "Session \"\(sessionName)\" is no longer running.",
                details: "The list has been refreshed. Sessions started by Claude Code or other wrappers can exit when their last client detaches.\n\nIf you believe the session is still alive, run\n\ttmux has-session -t '=\(sessionName)'\nin a terminal — exit code 0 means tmux can find it."
            )
            return
        }
        if focusAttachedClient(sessionName: sessionName) {
            return
        }
        openTerminalSession(sessionName: sessionName)
    }

    @objc private func killSession(_ sender: NSMenuItem) {
        guard let sessionName = sender.representedObject as? String else {
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Kill tmux session \"\(sessionName)\"?"
        alert.informativeText = "Any work in this session that isn't saved or piped out will be lost. Attached clients will be detached."
        alert.addButton(withTitle: "Kill Session")
        alert.addButton(withTitle: "Cancel")
        // Make the Kill button the destructive one — Enter still confirms,
        // but the button reads as red on macOS 11+.
        if #available(macOS 11.0, *) {
            alert.buttons.first?.hasDestructiveAction = true
        }
        if alert.runModal() != .alertFirstButtonReturn {
            return
        }
        let result = runTmux(["kill-session", "-t", "=\(sessionName)"])
        if result.status != 0 {
            showAlert("Could not kill session \(sessionName).", details: result.output)
        }
        rebuildMenu()
    }

    private func tmuxSessionExists(_ sessionName: String) -> Bool {
        // The =name prefix tells tmux to match the literal string, disabling
        // its session:window.pane parser. Without it, names containing ":"
        // or "." are mis-parsed and has-session reports false negatives.
        if runTmux(["has-session", "-t", "=\(sessionName)"]).status == 0 {
            return true
        }
        // Belt-and-suspenders: if has-session still fails on an unusual name,
        // fall back to scanning list-sessions output for an exact match. That
        // matches the very check that put the session in the menu in the
        // first place, so we never tell the user a listed session is gone
        // when it really isn't.
        let listing = runTmux(["list-sessions", "-F", "#{session_name}"])
        if listing.status != 0 {
            return false
        }
        return listing.output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .contains { String($0).trimmingCharacters(in: .whitespacesAndNewlines) == sessionName }
    }

    @objc private func createSession(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)

        let panel = NSOpenPanel()
        panel.title = "Choose folder for new tmux session"
        panel.prompt = "Choose"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        if panel.runModal() != .OK {
            return
        }
        guard let chosenCwd = panel.url?.path else {
            return
        }

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"
        field.stringValue = "termag-\(formatter.string(from: Date()))"

        let alert = NSAlert()
        alert.messageText = "Create tmux session"
        alert.informativeText = "New session will start in \(chosenCwd)."
        alert.accessoryView = field
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")

        if alert.runModal() != .alertFirstButtonReturn {
            return
        }

        let name = sanitizeSessionName(field.stringValue)
        if name.isEmpty {
            showAlert("Session name is required.", details: nil)
            return
        }

        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let bannerText = TermagBanner.render(
            version: agentVersion,
            deviceName: agentDeviceName,
            cwd: chosenCwd,
            shell: shell
        )
        let shellCommand = "printf %s \(shellQuote(bannerText)); exec \(shellQuote(shell))"
        let result = runTmux(["new-session", "-d", "-s", name, "-c", chosenCwd, "-x", "120", "-y", "32", shellCommand])
        if result.status != 0 {
            showAlert("Could not create tmux session.", details: result.output)
            return
        }

        _ = runTmux(["set-option", "-t", "=\(name)", "-w", "window-size", "largest"])
        _ = runTmux(["set-option", "-t", "=\(name)", "history-limit", "10000"])
        rebuildMenu()
    }

    @objc private func quitTermag(_ sender: NSMenuItem) {
        if parentPid > 0 {
            _ = Darwin.kill(parentPid, SIGTERM)
        }
        NSApp.terminate(nil)
    }

    @objc private func gitStatus(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let sessions = listSessions()
        if let firstSession = sessions.first {
            let result = runProcess("/usr/bin/git", args: ["-C", firstSession.path, "status", "--short"])
            showAlert("Git Status for \(firstSession.name)", details: result.output.isEmpty ? "No changes" : result.output)
        } else {
            showAlert("No active session", details: "Open a tmux session first to run git commands.")
        }
    }

    @objc private func gitPull(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let sessions = listSessions()
        if let firstSession = sessions.first {
            let result = runProcess("/usr/bin/git", args: ["-C", firstSession.path, "pull"])
            if result.status == 0 {
                showAlert("Git Pull", details: result.output.isEmpty ? "Already up to date" : result.output)
            } else {
                showAlert("Git Pull Failed", details: result.output)
            }
        } else {
            showAlert("No active session", details: "Open a tmux session first to run git commands.")
        }
    }

    @objc private func gitPush(_ sender: NSMenuItem) {
        NSApp.activate(ignoringOtherApps: true)
        let sessions = listSessions()
        if let firstSession = sessions.first {
            let result = runProcess("/usr/bin/git", args: ["-C", firstSession.path, "push"])
            if result.status == 0 {
                showAlert("Git Push", details: result.output.isEmpty ? "Pushed successfully" : result.output)
            } else {
                showAlert("Git Push Failed", details: result.output)
            }
        } else {
            showAlert("No active session", details: "Open a tmux session first to run git commands.")
        }
    }

    private func focusAttachedClient(sessionName: String) -> Bool {
        let ttys = attachedClientTtys(sessionName: sessionName)
        if ttys.isEmpty {
            return false
        }

        let terminal = normalizedTerminalApp()
        for tty in ttys {
            if (terminal == "terminal" || terminal == "auto") && focusTerminalApp(tty: tty) {
                return true
            }
            if (terminal == "iterm2" || terminal == "iterm" || terminal == "auto") && focusITerm2(tty: tty) {
                return true
            }
            if activateTerminalOwner(tty: tty) {
                return true
            }
        }
        return false
    }

    private func attachedClientTtys(sessionName: String) -> [String] {
        let result = runTmux(["list-clients", "-t", "=\(sessionName)", "-F", "#{client_tty}"])
        if result.status != 0 {
            return []
        }
        return result.output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func focusTerminalApp(tty: String) -> Bool {
        let script = """
        tell application "System Events"
          if not (exists application process "Terminal") then return "not-found"
        end tell
        tell application "Terminal"
          repeat with w in windows
            repeat with t in tabs of w
              if (tty of t as text) is "\(appleScriptString(tty))" then
                set selected tab of w to t
                set index of w to 1
                activate
                return "focused"
              end if
            end repeat
          end repeat
        end tell
        return "not-found"
        """
        return runAppleScript(script).output.contains("focused")
    }

    private func focusITerm2(tty: String) -> Bool {
        let script = """
        tell application "System Events"
          if not (exists application process "iTerm2") and not (exists application process "iTerm") then return "not-found"
        end tell
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if (tty of s as text) is "\(appleScriptString(tty))" then
                  select s
                  select t
                  activate
                  return "focused"
                end if
              end repeat
            end repeat
          end repeat
        end tell
        return "not-found"
        """
        return runAppleScript(script).output.contains("focused")
    }

    private func activateTerminalOwner(tty: String) -> Bool {
        let result = runProcess("/usr/sbin/lsof", args: ["-F", "pc", tty])
        if result.status != 0 {
            return false
        }

        var currentPid: pid_t?
        for line in result.output.split(separator: "\n", omittingEmptySubsequences: true).map(String.init) {
            if line.hasPrefix("p"), let pid = Int32(line.dropFirst()) {
                currentPid = pid_t(pid)
                continue
            }
            if line.hasPrefix("c"), let pid = currentPid {
                let command = String(line.dropFirst()).lowercased()
                if command.contains("terminal") || command.contains("iterm") || command.contains("ghostty") {
                    if let app = NSRunningApplication(processIdentifier: pid) {
                        return app.activate(options: [.activateIgnoringOtherApps])
                    }
                }
            }
        }
        return false
    }

    private func openTerminalSession(sessionName: String) {
        let terminal = normalizedTerminalApp()
        let isTerminalAppPrimary = terminal == "terminal" || terminal == "auto" || terminal.isEmpty

        let primaryResult: AppleScriptResult
        switch terminal {
        case "iterm2", "iterm":
            primaryResult = openITerm2Session(sessionName: sessionName)
        case "ghostty":
            // Ghostty is launched via open(1), not AppleScript. Map success/failure
            // onto the same result shape so the fallback branch below can stay generic.
            primaryResult = openGhosttySession(sessionName: sessionName)
                ? AppleScriptResult(ok: true, status: 0, output: "")
                : AppleScriptResult(ok: false, status: 1, output: "open(1) for Ghostty failed.")
        default:
            primaryResult = openTerminalAppSession(sessionName: sessionName)
        }
        if primaryResult.ok { return }

        // Fall back to Terminal.app only when it wasn't already the primary —
        // avoids opening a second Terminal tab on every click.
        if !isTerminalAppPrimary {
            let fallback = openTerminalAppSession(sessionName: sessionName)
            if fallback.ok { return }
            showOpenSessionFailure(primary: primaryResult, fallback: fallback)
            return
        }
        showOpenSessionFailure(primary: primaryResult, fallback: nil)
    }

    private func openTerminalAppSession(sessionName: String) -> AppleScriptResult {
        let command = attachCommand(sessionName: sessionName)
        let script = """
        tell application "Terminal"
          activate
          do script "\(appleScriptString(command))"
        end tell
        """
        let result = runAppleScript(script)
        // Terminal.app's "do script" returns a tab reference, so the script's
        // string output is never empty on success. Status is the only reliable
        // signal: 0 = the AppleScript ran end-to-end without throwing.
        return AppleScriptResult(ok: result.status == 0, status: result.status, output: result.output)
    }

    private func openITerm2Session(sessionName: String) -> AppleScriptResult {
        let command = attachCommand(sessionName: sessionName)
        let script = """
        tell application "iTerm2"
          activate
          create window with default profile
          tell current session of current window
            write text "\(appleScriptString(command))"
          end tell
        end tell
        """
        let result = runAppleScript(script)
        return AppleScriptResult(ok: result.status == 0, status: result.status, output: result.output)
    }

    private func showOpenSessionFailure(primary: AppleScriptResult, fallback: AppleScriptResult?) {
        let attempts = [("primary", primary), ("fallback", fallback)].compactMap { (label, value) -> String? in
            guard let value = value else { return nil }
            let trimmed = value.output.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return "\(label): status \(value.status)" }
            return "\(label): \(trimmed.prefix(200))"
        }.joined(separator: "\n")

        let combinedOutput = "\(primary.output)\n\(fallback?.output ?? "")"
        if combinedOutput.contains("Not authorized") || combinedOutput.contains("not allowed assistive") || combinedOutput.contains("(-1743)") {
            showAlert(
                "Termag isn't allowed to control your terminal.",
                details: "Open System Settings → Privacy & Security → Automation, expand the Termag entry, and enable Terminal (or iTerm). Then try again.\n\n\(attempts)"
            )
            return
        }
        showAlert(
            "Could not open tmux session.",
            details: "\(attempts)\n\nSet menuBar.terminalApp in ~/.termag/config.json (Terminal, iTerm2, or Ghostty) if the wrong app is being targeted."
        )
    }

    private func openGhosttySession(sessionName: String) -> Bool {
        let result = runProcess("/usr/bin/open", args: [
            "-na", "Ghostty",
            "--args",
            "-e", tmuxPath, "attach-session", "-t", "=\(sessionName)"
        ])
        return result.status == 0
    }

    private func attachCommand(sessionName: String) -> String {
        // The =name exact-match prefix is required for names containing ":"
        // or ".", which tmux otherwise treats as session:window.pane.
        "\(shellQuote(tmuxPath)) attach-session -t \(shellQuote("=\(sessionName)"))"
    }

    private func listSessions() -> [TmuxSession] {
        let result = runTmux(["list-sessions", "-F", "#{session_name}\t#{session_path}\t#{session_windows}\t#{session_attached}"])
        if result.status != 0 {
            return []
        }

        return result.output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap { line in
                let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                if parts.isEmpty || parts[0].isEmpty {
                    return nil
                }
                let name = parts[0]
                let path = parts.count > 1 ? parts[1] : ""
                let windowCount = parts.count > 2 ? parts[2] : "0"
                let clientCount = parts.count > 3 ? Int(parts[3]) ?? 0 : 0
                return TmuxSession(name: name, path: path, windowCount: windowCount, clientCount: clientCount, windows: listWindows(sessionName: name))
            }
            .sorted { left, right in
                left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    private func listWindows(sessionName: String) -> [TmuxWindow] {
        let result = runTmux(["list-windows", "-t", "=\(sessionName)", "-F", "#{window_index}\t#{window_name}"])
        if result.status != 0 {
            return []
        }

        return result.output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .compactMap { line in
                let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                if parts.isEmpty {
                    return nil
                }
                return TmuxWindow(index: parts[0], name: parts.count > 1 ? parts[1] : "window")
            }
    }

    private func runTmux(_ args: [String]) -> (status: Int32, output: String) {
        return runProcess(tmuxPath, args: args)
    }

    private func runAppleScript(_ script: String) -> (status: Int32, output: String) {
        return runProcess("/usr/bin/osascript", args: ["-e", script])
    }

    private func runProcess(_ executable: String, args: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        do {
            try process.run()
        } catch {
            return (127, error.localizedDescription)
        }

        process.waitUntilExit()
        let stdoutText = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderrText = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdoutText.isEmpty ? stderrText : stdoutText)
    }

    private func normalizedTerminalApp() -> String {
        let value = requestedTerminalApp.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.isEmpty {
            return "terminal"
        }
        if value == "auto" {
            return "auto"
        }
        if value.contains("iterm") {
            return "iterm2"
        }
        if value.contains("ghostty") {
            return "ghostty"
        }
        if value.contains("terminal") {
            return "terminal"
        }
        return value
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private func appleScriptString(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
    }

    private func sanitizeSessionName(_ raw: String) -> String {
        var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        name = name.replacingOccurrences(of: "[:\\r\\n\\t]", with: " ", options: .regularExpression)
        name = name.replacingOccurrences(of: "[^A-Za-z0-9_. -]", with: "-", options: .regularExpression)
        name = name.replacingOccurrences(of: "\\s+", with: "-", options: .regularExpression)
        name = name.replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
        name = name.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if name.count > 80 {
            name = String(name.prefix(80))
        }
        return name
    }

    private func showAlert(_ message: String, details: String?) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        if let details = details, !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            alert.informativeText = details
        }
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = TermagStatusController()
app.delegate = delegate
app.run()
`;
