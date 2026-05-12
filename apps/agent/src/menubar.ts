import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type StartMacMenuBarOptions = {
  tag: string;
};

type AgentConfig = {
  macMenuBar?: boolean;
  terminalApp?: string;
  menuBar?: {
    enabled?: boolean;
    terminalApp?: string;
  };
};

let activeMenuBar: ChildProcess | null = null;

const MAC_PATH = [
  process.env.PATH,
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].filter(Boolean).join(':');

export function startMacMenuBar(opts: StartMacMenuBarOptions): ChildProcess | null {
  if (process.platform !== 'darwin') return null;
  if (process.env.TERMAG_AGENT_FAKE === 'true') return null;
  const config = loadAgentConfig(opts.tag);
  if (!menuBarEnabled(config)) return null;
  if (activeMenuBar && !activeMenuBar.killed) return activeMenuBar;

  const tmuxPath = resolveCommand('tmux');
  if (!tmuxPath) {
    console.warn(`[${opts.tag}] mac menu bar disabled: tmux not found.`);
    return null;
  }

  const scriptPath = writeMenuBarScript();
  const helperPath = compileMenuBarHelper(scriptPath, opts.tag);
  if (!helperPath) return null;

  const child = spawn(
    helperPath,
    [
      String(process.pid),
      tmuxPath,
      terminalApp(config)
    ],
    {
      detached: false,
      stdio: 'ignore',
      env: { ...process.env, PATH: MAC_PATH }
    }
  );

  activeMenuBar = child;
  child.unref();

  let startupWindow = true;
  setTimeout(() => { startupWindow = false; }, 3000).unref();
  child.on('error', (err) => {
    if (activeMenuBar === child) activeMenuBar = null;
    console.warn(`[${opts.tag}] mac menu bar could not start: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (activeMenuBar === child) activeMenuBar = null;
    if (startupWindow && code !== 0 && signal !== 'SIGTERM') {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      console.warn(`[${opts.tag}] mac menu bar exited during startup (${reason}).`);
    }
  });

  return child;
}

export function stopMacMenuBar() {
  if (!activeMenuBar) return;
  try {
    activeMenuBar.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  activeMenuBar = null;
}

function loadAgentConfig(tag: string): AgentConfig {
  const configPath = path.resolve(expandHome(process.env.TERMAG_CONFIG || path.join(os.homedir(), '.termag', 'config.json')));
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as AgentConfig;
  } catch (err) {
    console.warn(`[${tag}] ignoring invalid config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function menuBarEnabled(config: AgentConfig) {
  if (process.env.TERMAG_NO_MENUBAR === 'true') return false;
  if (process.env.TERMAG_MAC_MENUBAR === 'false') return false;
  if (process.env.TERMAG_MAC_MENUBAR === 'true') return true;
  if (typeof config.menuBar?.enabled === 'boolean') return config.menuBar.enabled;
  if (typeof config.macMenuBar === 'boolean') return config.macMenuBar;
  return false;
}

function terminalApp(config: AgentConfig) {
  return (
    process.env.TERMAG_TERMINAL_APP?.trim()
    || config.menuBar?.terminalApp?.trim()
    || config.terminalApp?.trim()
    || terminalAppFromTermProgram()
    || 'Terminal'
  );
}

function terminalAppFromTermProgram() {
  const value = process.env.TERM_PROGRAM?.toLowerCase();
  if (value === 'apple_terminal') return 'Terminal';
  if (value === 'iterm.app' || value === 'iterm2') return 'iTerm2';
  if (value === 'ghostty') return 'Ghostty';
  return '';
}

function resolveCommand(command: 'swiftc' | 'tmux'): string | null {
  const knownPath = command === 'swiftc' ? '/usr/bin/swiftc' : '';
  if (knownPath && existsSync(knownPath)) return knownPath;

  try {
    const stdout = execFileSync('/bin/sh', ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: MAC_PATH },
      timeout: 2000
    }).trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function expandHome(value: string) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function writeMenuBarScript() {
  const dir = path.join(os.homedir(), '.termag');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(dir, 'termag-menubar.swift');
  writeFileSync(scriptPath, MAC_MENU_BAR_SWIFT, { mode: 0o600 });
  return scriptPath;
}

function compileMenuBarHelper(scriptPath: string, tag: string): string | null {
  const swiftcPath = resolveCommand('swiftc');
  if (!swiftcPath) {
    console.warn(`[${tag}] mac menu bar disabled: swiftc not found. Install Xcode Command Line Tools, or set TERMAG_MAC_MENUBAR=false.`);
    return null;
  }

  const helperPath = path.join(os.homedir(), '.termag', 'termag-menubar');
  try {
    const scriptStat = statSync(scriptPath);
    const helperStat = existsSync(helperPath) ? statSync(helperPath) : null;
    if (!helperStat || helperStat.mtimeMs < scriptStat.mtimeMs) {
      execFileSync(swiftcPath, [scriptPath, '-o', helperPath], {
        env: { ...process.env, PATH: MAC_PATH },
        timeout: 60_000
      });
    }
    return helperPath;
  } catch (err) {
    console.warn(`[${tag}] mac menu bar disabled: could not compile helper: ${err instanceof Error ? err.message : String(err)}`);
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

        let title = NSMenuItem(title: "Termag", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

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
        if focusAttachedClient(sessionName: sessionName) {
            return
        }
        openTerminalSession(sessionName: sessionName)
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
        let result = runTmux(["new-session", "-d", "-s", name, "-c", chosenCwd, "-x", "120", "-y", "32", shell])
        if result.status != 0 {
            showAlert("Could not create tmux session.", details: result.output)
            return
        }

        _ = runTmux(["set-option", "-t", name, "-w", "window-size", "largest"])
        _ = runTmux(["set-option", "-t", name, "history-limit", "10000"])
        rebuildMenu()
    }

    @objc private func quitTermag(_ sender: NSMenuItem) {
        if parentPid > 0 {
            _ = Darwin.kill(parentPid, SIGTERM)
        }
        NSApp.terminate(nil)
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
        let result = runTmux(["list-clients", "-t", sessionName, "-F", "#{client_tty}"])
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
        return runAppleScript(script).contains("focused")
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
        return runAppleScript(script).contains("focused")
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
        if terminal == "iterm2" || terminal == "iterm" {
            if openITerm2Session(sessionName: sessionName) {
                return
            }
        } else if terminal == "ghostty" {
            if openGhosttySession(sessionName: sessionName) {
                return
            }
        } else if terminal == "terminal" || terminal == "auto" {
            if openTerminalAppSession(sessionName: sessionName) {
                return
            }
        }

        if !openTerminalAppSession(sessionName: sessionName) {
            showAlert("Could not open tmux session.", details: "Configure ~/.termag/config.json with menuBar.terminalApp set to Terminal, iTerm2, or Ghostty.")
        }
    }

    private func openTerminalAppSession(sessionName: String) -> Bool {
        let command = attachCommand(sessionName: sessionName)
        let script = """
        tell application "Terminal"
          activate
          do script "\(appleScriptString(command))"
        end tell
        """
        return runAppleScript(script).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func openITerm2Session(sessionName: String) -> Bool {
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
        return runAppleScript(script).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func openGhosttySession(sessionName: String) -> Bool {
        let result = runProcess("/usr/bin/open", args: [
            "-na", "Ghostty",
            "--args",
            "-e", tmuxPath, "attach-session", "-t", sessionName
        ])
        return result.status == 0
    }

    private func attachCommand(sessionName: String) -> String {
        "\(shellQuote(tmuxPath)) attach-session -t \(shellQuote(sessionName))"
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
        let result = runTmux(["list-windows", "-t", sessionName, "-F", "#{window_index}\t#{window_name}"])
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

    private func runAppleScript(_ script: String) -> String {
        let result = runProcess("/usr/bin/osascript", args: ["-e", script])
        if result.status != 0 {
            return result.output
        }
        return result.output
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
