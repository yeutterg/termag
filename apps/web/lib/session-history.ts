export interface SessionSnapshot {
  sessionId: string;
  projectId: string;
  tabId: string;
  timestamp: string;
  state: {
    terminalContent?: string;
    cursorPosition?: { x: number; y: number };
    workingDirectory?: string;
    lastCommand?: string;
  };
}

export interface SessionHistory {
  sessionId: string;
  snapshots: SessionSnapshot[];
  lastSaved: string;
  autoSaveEnabled: boolean;
}

const HISTORY_KEY = "termag-session-history";
const AUTOSAVE_INTERVAL = 30000; // 30 seconds
const MAX_SNAPSHOTS = 10;

/**
 * Get session history from localStorage
 */
export function getSessionHistory(sessionId: string): SessionHistory | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) {
      return null;
    }

    const allHistory: Record<string, SessionHistory> = JSON.parse(stored);
    return allHistory[sessionId] || null;
  } catch (error) {
    console.error("Failed to load session history:", error);
    return null;
  }
}

/**
 * Save session history to localStorage
 */
export function saveSessionHistory(sessionId: string, history: SessionHistory): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const stored = localStorage.getItem(HISTORY_KEY) || "{}";
    const allHistory: Record<string, SessionHistory> = JSON.parse(stored);

    allHistory[sessionId] = history;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(allHistory));
  } catch (error) {
    console.error("Failed to save session history:", error);
  }
}

/**
 * Create a session snapshot
 */
export function createSnapshot(
  sessionId: string,
  projectId: string,
  tabId: string,
  state: SessionSnapshot["state"]
): SessionSnapshot {
  return {
    sessionId,
    projectId,
    tabId,
    timestamp: new Date().toISOString(),
    state,
  };
}

/**
 * Save a snapshot to session history
 */
export function saveSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  let history = getSessionHistory(sessionId);

  if (!history) {
    history = {
      sessionId,
      snapshots: [],
      lastSaved: new Date().toISOString(),
      autoSaveEnabled: true,
    };
  }

  // Add new snapshot
  history.snapshots.push(snapshot);

  // Keep only the last N snapshots
  if (history.snapshots.length > MAX_SNAPSHOTS) {
    history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS);
  }

  history.lastSaved = new Date().toISOString();
  saveSessionHistory(sessionId, history);
}

/**
 * Get the latest snapshot for a session
 */
export function getLatestSnapshot(sessionId: string): SessionSnapshot | null {
  const history = getSessionHistory(sessionId);
  if (!history || history.snapshots.length === 0) {
    return null;
  }

  return history.snapshots[history.snapshots.length - 1];
}

/**
 * Get all snapshots for a session
 */
export function getAllSnapshots(sessionId: string): SessionSnapshot[] {
  const history = getSessionHistory(sessionId);
  return history?.snapshots || [];
}

/**
 * Delete session history
 */
export function deleteSessionHistory(sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) {
      return;
    }

    const allHistory: Record<string, SessionHistory> = JSON.parse(stored);
    delete allHistory[sessionId];

    localStorage.setItem(HISTORY_KEY, JSON.stringify(allHistory));
  } catch (error) {
    console.error("Failed to delete session history:", error);
  }
}

/**
 * Clear all session history
 */
export function clearAllSessionHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch (error) {
    console.error("Failed to clear session history:", error);
  }
}

/**
 * Enable/disable auto-save for a session
 */
export function setAutoSave(sessionId: string, enabled: boolean): void {
  let history = getSessionHistory(sessionId);

  if (!history) {
    history = {
      sessionId,
      snapshots: [],
      lastSaved: new Date().toISOString(),
      autoSaveEnabled: enabled,
    };
  } else {
    history.autoSaveEnabled = enabled;
  }

  saveSessionHistory(sessionId, history);
}

/**
 * Check if auto-save is enabled for a session
 */
export function isAutoSaveEnabled(sessionId: string): boolean {
  const history = getSessionHistory(sessionId);
  return history?.autoSaveEnabled ?? true;
}

/**
 * Auto-save hook for React components
 */
export function useAutoSave(
  sessionId: string,
  projectId: string,
  tabId: string,
  getState: () => SessionSnapshot["state"],
  enabled: boolean = true
) {
  if (typeof window === "undefined") {
    return { cancel: () => {} };
  }

  let intervalId: NodeJS.Timeout | null = null;

  const startAutoSave = () => {
    if (!enabled || !isAutoSaveEnabled(sessionId)) {
      return;
    }

    intervalId = setInterval(() => {
      const state = getState();
      const snapshot = createSnapshot(sessionId, projectId, tabId, state);
      saveSnapshot(sessionId, snapshot);
    }, AUTOSAVE_INTERVAL);
  };

  const stopAutoSave = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const saveNow = () => {
    const state = getState();
    const snapshot = createSnapshot(sessionId, projectId, tabId, state);
    saveSnapshot(sessionId, snapshot);
  };

  startAutoSave();

  return {
    cancel: stopAutoSave,
    saveNow,
  };
}

/**
 * Recover session from snapshot
 */
export function recoverFromSnapshot(snapshot: SessionSnapshot): SessionSnapshot["state"] {
  return snapshot.state;
}

/**
 * Check if session has recovery data
 */
export function hasRecoveryData(sessionId: string): boolean {
  const snapshot = getLatestSnapshot(sessionId);
  return snapshot !== null;
}

/**
 * Get time since last save
 */
export function getTimeSinceLastSave(sessionId: string): number | null {
  const history = getSessionHistory(sessionId);
  if (!history || !history.lastSaved) {
    return null;
  }

  const lastSaved = new Date(history.lastSaved).getTime();
  const now = Date.now();
  return now - lastSaved;
}

/**
 * Format time since last save
 */
export function formatTimeSinceLastSave(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ago`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s ago`;
  } else {
    return `${seconds}s ago`;
  }
}
