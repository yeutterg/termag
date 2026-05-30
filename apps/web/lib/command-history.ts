export interface CommandEntry {
  id: string;
  command: string;
  sessionId: string;
  projectId: string;
  tabId: string;
  timestamp: string;
  executionCount: number;
  lastExecuted: string;
  workingDirectory?: string;
  exitCode?: number;
}

const COMMAND_HISTORY_KEY = "termag-command-history";
const MAX_HISTORY_SIZE = 1000;

/**
 * Get all command history from localStorage
 */
export function getCommandHistory(): CommandEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(COMMAND_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to load command history:", error);
    return [];
  }
}

/**
 * Save command history to localStorage
 */
export function saveCommandHistory(history: CommandEntry[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Keep only the last N entries
    const trimmed = history.slice(-MAX_HISTORY_SIZE);
    localStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.error("Failed to save command history:", error);
  }
}

/**
 * Record a command execution
 */
export function recordCommand(
  command: string,
  sessionId: string,
  projectId: string,
  tabId: string,
  options?: {
    workingDirectory?: string;
    exitCode?: number;
  }
): void {
  const history = getCommandHistory();

  // Check if command already exists
  const existingIndex = history.findIndex(
    entry => entry.command === command && entry.sessionId === sessionId
  );

  if (existingIndex >= 0) {
    // Update existing entry
    history[existingIndex].executionCount += 1;
    history[existingIndex].lastExecuted = new Date().toISOString();
    if (options?.workingDirectory) {
      history[existingIndex].workingDirectory = options.workingDirectory;
    }
    if (options?.exitCode !== undefined) {
      history[existingIndex].exitCode = options.exitCode;
    }
  } else {
    // Create new entry
    const newEntry: CommandEntry = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      command,
      sessionId,
      projectId,
      tabId,
      timestamp: new Date().toISOString(),
      executionCount: 1,
      lastExecuted: new Date().toISOString(),
      workingDirectory: options?.workingDirectory,
      exitCode: options?.exitCode,
    };

    history.push(newEntry);
  }

  saveCommandHistory(history);
}

/**
 * Search command history with fuzzy matching
 */
export function searchCommandHistory(
  query: string,
  options?: {
    sessionId?: string;
    projectId?: string;
    limit?: number;
  }
): CommandEntry[] {
  const history = getCommandHistory();
  const limit = options?.limit || 20;

  if (!query.trim()) {
    // Return most recent commands if no query
    let filtered = history;
    if (options?.sessionId) {
      filtered = filtered.filter(h => h.sessionId === options.sessionId);
    }
    if (options?.projectId) {
      filtered = filtered.filter(h => h.projectId === options.projectId);
    }
    return filtered
      .sort((a, b) => new Date(b.lastExecuted).getTime() - new Date(a.lastExecuted).getTime())
      .slice(0, limit);
  }

  // Fuzzy search implementation
  const queryLower = query.toLowerCase();
  const results = history
    .filter(entry => {
      // Filter by session/project if specified
      if (options?.sessionId && entry.sessionId !== options.sessionId) {
        return false;
      }
      if (options?.projectId && entry.projectId !== options.projectId) {
        return false;
      }

      // Fuzzy match
      const commandLower = entry.command.toLowerCase();
      return commandLower.includes(queryLower) || fuzzyMatch(commandLower, queryLower);
    })
    .map(entry => ({
      ...entry,
      score: calculateScore(entry, queryLower),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ _score, ...entry }) => entry);

  return results;
}

/**
 * Simple fuzzy matching
 */
function fuzzyMatch(text: string, query: string): boolean {
  let queryIndex = 0;
  for (let i = 0; i < text.length && queryIndex < query.length; i++) {
    if (text[i] === query[queryIndex]) {
      queryIndex++;
    }
  }
  return queryIndex === query.length;
}

/**
 * Calculate relevance score for a command entry
 */
function calculateScore(entry: CommandEntry, query: string): number {
  let score = 0;
  const commandLower = entry.command.toLowerCase();

  // Exact match gets highest score
  if (commandLower === query) {
    score += 100;
  } else if (commandLower.startsWith(query)) {
    score += 50;
  }

  // Boost for frequent commands
  score += Math.min(entry.executionCount * 5, 25);

  // Boost for recent commands (last 24 hours)
  const lastExecuted = new Date(entry.lastExecuted).getTime();
  const now = Date.now();
  const hoursSince = (now - lastExecuted) / (1000 * 60 * 60);
  if (hoursSince < 1) {
    score += 20;
  } else if (hoursSince < 24) {
    score += 10;
  } else if (hoursSince < 168) {
    score += 5;
  } // 1 week

  // Penalize failed commands
  if (entry.exitCode && entry.exitCode !== 0) {
    score -= 10;
  }

  return score;
}

/**
 * Get frequently used commands
 */
export function getFrequentCommands(options?: {
  sessionId?: string;
  projectId?: string;
  limit?: number;
}): CommandEntry[] {
  const history = getCommandHistory();
  const limit = options?.limit || 10;

  let filtered = history;
  if (options?.sessionId) {
    filtered = filtered.filter(h => h.sessionId === options.sessionId);
  }
  if (options?.projectId) {
    filtered = filtered.filter(h => h.projectId === options.projectId);
  }

  return filtered.sort((a, b) => b.executionCount - a.executionCount).slice(0, limit);
}

/**
 * Get recent commands
 */
export function getRecentCommands(options?: {
  sessionId?: string;
  projectId?: string;
  limit?: number;
}): CommandEntry[] {
  const history = getCommandHistory();
  const limit = options?.limit || 10;

  let filtered = history;
  if (options?.sessionId) {
    filtered = filtered.filter(h => h.sessionId === options.sessionId);
  }
  if (options?.projectId) {
    filtered = filtered.filter(h => h.projectId === options.projectId);
  }

  return filtered
    .sort((a, b) => new Date(b.lastExecuted).getTime() - new Date(a.lastExecuted).getTime())
    .slice(0, limit);
}

/**
 * Delete a command from history
 */
export function deleteCommand(commandId: string): void {
  const history = getCommandHistory();
  const filtered = history.filter(h => h.id !== commandId);
  saveCommandHistory(filtered);
}

/**
 * Clear all command history
 */
export function clearCommandHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(COMMAND_HISTORY_KEY);
  } catch (error) {
    console.error("Failed to clear command history:", error);
  }
}

/**
 * Clear command history for a specific session
 */
export function clearSessionCommandHistory(sessionId: string): void {
  const history = getCommandHistory();
  const filtered = history.filter(h => h.sessionId !== sessionId);
  saveCommandHistory(filtered);
}

/**
 * Get command statistics
 */
export function getCommandStats(): {
  totalCommands: number;
  uniqueCommands: number;
  mostUsedCommand: string | null;
  averageExecutionCount: number;
} {
  const history = getCommandHistory();

  if (history.length === 0) {
    return {
      totalCommands: 0,
      uniqueCommands: 0,
      mostUsedCommand: null,
      averageExecutionCount: 0,
    };
  }

  const commandCounts = new Map<string, number>();
  let totalExecutions = 0;

  history.forEach(entry => {
    commandCounts.set(entry.command, entry.executionCount);
    totalExecutions += entry.executionCount;
  });

  let mostUsedCommand: string | null = null;
  let maxCount = 0;

  commandCounts.forEach((count, command) => {
    if (count > maxCount) {
      maxCount = count;
      mostUsedCommand = command;
    }
  });

  return {
    totalCommands: history.length,
    uniqueCommands: commandCounts.size,
    mostUsedCommand,
    averageExecutionCount: totalExecutions / history.length,
  };
}
