import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:path";
import { homedir } from "node:os";

export interface AgentStatus {
  connected: boolean; // Connected to broker
  brokerUrl: string;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  currentProject: string | null;
  currentBranch: string | null;
  activeSessions: number;
}

const STATUS_DIR = os.join(homedir(), ".termag");
const STATUS_FILE = os.join(STATUS_DIR, "agent-status.json");

const currentStatus: AgentStatus = {
  connected: false,
  brokerUrl: "",
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  currentProject: null,
  currentBranch: null,
  activeSessions: 0,
};

// Debounce status file writes to reduce I/O
let writeTimeout: ReturnType<typeof setTimeout> | null = null;
const WRITE_DEBOUNCE_MS = 500; // Debounce writes to 500ms

/**
 * Initialize status file directory
 */
export function initStatusFile() {
  if (!existsSync(STATUS_DIR)) {
    mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  }
  writeStatus();
}

/**
 * Update agent connection status (debounced)
 */
export function updateConnectionStatus(connected: boolean, brokerUrl: string) {
  const now = new Date().toISOString();

  if (connected && !currentStatus.connected) {
    currentStatus.lastConnectedAt = now;
  } else if (!connected && currentStatus.connected) {
    currentStatus.lastDisconnectedAt = now;
  }

  currentStatus.connected = connected;
  currentStatus.brokerUrl = brokerUrl;
  debouncedWrite();
}

/**
 * Update current project context (debounced)
 */
export function updateProjectContext(project: string | null, branch: string | null) {
  currentStatus.currentProject = project;
  currentStatus.currentBranch = branch;
  debouncedWrite();
}

/**
 * Update active session count (debounced)
 */
export function updateActiveSessions(count: number) {
  currentStatus.activeSessions = count;
  debouncedWrite();
}

/**
 * Get current status
 */
export function getStatus(): AgentStatus {
  return { ...currentStatus };
}

/**
 * Write status to file immediately (for shutdown)
 */
export function writeStatusSync() {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2), { mode: 0o600 });
  } catch (err) {
    // Silently fail - status file is optional
  }
}

/**
 * Debounced write to reduce I/O
 */
function debouncedWrite() {
  if (writeTimeout) {
    clearTimeout(writeTimeout);
  }
  writeTimeout = setTimeout(() => {
    try {
      writeFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2), { mode: 0o600 });
    } catch (err) {
      // Silently fail - status file is optional
    }
    writeTimeout = null;
  }, WRITE_DEBOUNCE_MS).unref();
}

/**
 * Write status to file for menubar to read (legacy, kept for compatibility)
 */
function writeStatus() {
  debouncedWrite();
}

/**
 * Clean up status file on shutdown
 */
export function cleanupStatusFile() {
  if (writeTimeout) {
    clearTimeout(writeTimeout);
  }
  // Write final status before cleanup
  writeStatusSync();
  try {
    if (existsSync(STATUS_FILE)) {
      unlinkSync(STATUS_FILE);
    }
  } catch {
    // Ignore cleanup errors
  }
}
