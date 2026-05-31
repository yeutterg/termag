#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUS_FILE = path.join(os.homedir(), ".termag", "agent-status.json");

interface AgentStatus {
  connected: boolean;
  brokerUrl: string;
  currentProject: string | null;
  currentBranch: string | null;
  activeSessions: number;
}

function readAgentStatus(): AgentStatus | null {
  if (!existsSync(STATUS_FILE)) {
    return null;
  }
  try {
    const data = readFileSync(STATUS_FILE, "utf8");
    return JSON.parse(data) as AgentStatus;
  } catch {
    return null;
  }
}

function runTmux(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync("tmux", args, { encoding: "utf8" });
    return { status: 0, output };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; status?: number };
    return {
      status: error.status || 1,
      output: error.stdout || error.stderr || "",
    };
  }
}

function listSessions(): Array<{ name: string; path: string }> {
  const result = runTmux(["list-sessions", "-F", "#{session_name}\t#{session_path}"]);
  if (result.status !== 0) {
    return [];
  }

  return result.output
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      const [name, path] = line.split("\t");
      return { name, path: path || "" };
    });
}

function showHelp() {
  console.log(`
termag CLI - Quick terminal commands for termag

Usage: termag <command> [args]

Commands:
  status          Show agent connection status
  sessions        List all tmux sessions
  open [session]  Open terminal for session (or first session if not specified)
  git [cmd]       Run git command in first session's directory
  search [query]  Search for query in first session's directory
  new [dir]       Create new tmux session in directory
  help            Show this help message

Examples:
  termag status              # Check if agent is connected
  termag sessions            # List all sessions
  termag open my-project     # Open specific session
  termag open                # Open first available session
  termag git status          # Run git status in current project
  termag git pull            # Pull changes in current project
  termag search function     # Search for "function" in code
  termag new ~/projects/app  # Create new session in directory
`);
}

function cmdStatus() {
  const status = readAgentStatus();
  if (!status) {
    console.log("Agent status: Unknown (status file not found)");
    console.log("Make sure the termag agent is running.");
    process.exit(1);
  }

  const emoji = status.connected ? "🟢" : "🟡";
  console.log(`Agent status: ${emoji} ${status.connected ? "Connected" : "Disconnected"}`);
  if (status.brokerUrl) {
    console.log(`Broker: ${status.brokerUrl}`);
  }
  if (status.currentProject) {
    console.log(`Project: ${status.currentProject}`);
  }
  if (status.currentBranch) {
    console.log(`Branch: ${status.currentBranch}`);
  }
  console.log(`Active sessions: ${status.activeSessions}`);
}

function cmdSessions() {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No tmux sessions found");
    return;
  }

  console.log("\nTmux Sessions:");
  sessions.forEach(session => {
    const attached = runTmux(["list-clients", "-t", session.name]).status === 0;
    const status = attached ? "🟢" : "🟡";
    console.log(`  ${status} ${session.name}`);
    if (session.path) {
      console.log(`    ${session.path}`);
    }
  });
}

function cmdOpen(sessionName?: string) {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No tmux sessions found. Create one with 'termag new'");
    process.exit(1);
  }

  const targetSession = sessionName ? sessions.find(s => s.name === sessionName) : sessions[0];

  if (!targetSession) {
    console.log(`Session "${sessionName}" not found`);
    console.log("Available sessions:");
    sessions.forEach(s => console.log(`  - ${s.name}`));
    process.exit(1);
  }

  // Try to focus existing client first
  const attached = runTmux(["list-clients", "-t", targetSession.name]).status === 0;
  if (attached) {
    console.log(`Session "${targetSession.name}" already has attached client`);
    // Could add logic to focus the terminal window here
    return;
  }

  // Attach to session
  console.log(`Attaching to session: ${targetSession.name}`);
  const result = runTmux(["attach-session", "-t", targetSession.name]);
  if (result.status !== 0) {
    console.error(`Failed to attach: ${result.output}`);
    process.exit(1);
  }
}

function cmdGit(args: string[]) {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No tmux sessions found");
    process.exit(1);
  }

  const session = sessions[0];
  if (!session.path) {
    console.log("Session has no working directory");
    process.exit(1);
  }

  const result = runTmux(["send-keys", "-t", session.name, `git ${args.join(" ")}\n`, "Enter"]);
  if (result.status === 0) {
    console.log("Running: git " + args.join(" "));
  } else {
    console.error("Failed to send command: " + result.output);
    process.exit(1);
  }
}

function cmdSearch(query: string) {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log("No tmux sessions found");
    process.exit(1);
  }

  const session = sessions[0];
  if (!session.path) {
    console.log("Session has no working directory");
    process.exit(1);
  }

  // Run grep in the session's directory
  const result = execFileSync("grep", ["-rn", query, session.path], {
    encoding: "utf8",
  });
  console.log(result);
}

function cmdNew(directory?: string) {
  const cwd = directory || process.cwd();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const sessionName = `termag-${timestamp}`;

  const result = runTmux(["new-session", "-d", "-s", sessionName, "-c", cwd]);

  if (result.status === 0) {
    console.log(`Created session: ${sessionName}`);
    console.log(`Directory: ${cwd}`);
    console.log(`Attach with: termag open ${sessionName}`);
  } else {
    console.error(`Failed to create session: ${result.output}`);
    process.exit(1);
  }
}

// Main CLI logic
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "status":
    cmdStatus();
    break;
  case "sessions":
    cmdSessions();
    break;
  case "open":
    cmdOpen(args[1]);
    break;
  case "git":
    if (!args[1]) {
      console.log("Usage: termag git <command>");
      console.log("Example: termag git status");
      process.exit(1);
    }
    cmdGit(args.slice(1));
    break;
  case "search":
    if (!args[1]) {
      console.log("Usage: termag search <query>");
      console.log("Example: termag search function");
      process.exit(1);
    }
    cmdSearch(args[1]);
    break;
  case "new":
    cmdNew(args[1]);
    break;
  case "help":
  case "--help":
  case "-h":
    showHelp();
    break;
  default:
    if (!command) {
      showHelp();
    } else {
      console.log(`Unknown command: ${command}`);
      console.log("Run 'termag help' for usage");
      process.exit(1);
    }
}
