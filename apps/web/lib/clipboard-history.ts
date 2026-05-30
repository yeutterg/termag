export interface ClipboardEntry {
  id: string;
  content: string;
  timestamp: string;
  type: "text" | "command" | "output";
  source?: string;
}

const CLIPBOARD_HISTORY_KEY = "termag-clipboard-history";
const MAX_HISTORY_SIZE = 100;

/**
 * Get clipboard history from localStorage
 */
export function getClipboardHistory(): ClipboardEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(CLIPBOARD_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to load clipboard history:", error);
    return [];
  }
}

/**
 * Save clipboard history to localStorage
 */
export function saveClipboardHistory(history: ClipboardEntry[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const trimmed = history.slice(-MAX_HISTORY_SIZE);
    localStorage.setItem(CLIPBOARD_HISTORY_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.error("Failed to save clipboard history:", error);
  }
}

/**
 * Add entry to clipboard history
 */
export function addToClipboardHistory(
  content: string,
  type: "text" | "command" | "output" = "text",
  source?: string
): void {
  const history = getClipboardHistory();

  const entry: ClipboardEntry = {
    id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    content,
    type,
    timestamp: new Date().toISOString(),
    source,
  };

  // Avoid duplicates
  if (history.length > 0 && history[0].content === content) {
    return;
  }

  history.unshift(entry);
  saveClipboardHistory(history);
}

/**
 * Copy text to clipboard and add to history
 */
export async function copyToClipboard(
  text: string,
  type: "text" | "command" | "output" = "text",
  source?: string
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    addToClipboardHistory(text, type, source);
    return true;
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return false;
  }
}

/**
 * Get text from clipboard
 */
export async function getFromClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch (error) {
    console.error("Failed to read from clipboard:", error);
    return "";
  }
}

/**
 * Copy last command output
 */
export function copyLastOutput(output: string): Promise<boolean> {
  return copyToClipboard(output, "output", "terminal");
}

/**
 * Copy current line
 */
export function copyCurrentLine(line: string): Promise<boolean> {
  return copyToClipboard(line, "text", "terminal");
}

/**
 * Search clipboard history
 */
export function searchClipboardHistory(query: string): ClipboardEntry[] {
  const history = getClipboardHistory();
  const queryLower = query.toLowerCase();

  return history.filter(
    entry =>
      entry.content.toLowerCase().includes(queryLower) ||
      entry.source?.toLowerCase().includes(queryLower)
  );
}

/**
 * Delete entry from clipboard history
 */
export function deleteClipboardEntry(entryId: string): void {
  const history = getClipboardHistory();
  const filtered = history.filter(h => h.id !== entryId);
  saveClipboardHistory(filtered);
}

/**
 * Clear clipboard history
 */
export function clearClipboardHistory(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(CLIPBOARD_HISTORY_KEY);
  } catch (error) {
    console.error("Failed to clear clipboard history:", error);
  }
}

/**
 * Format timestamp for display
 */
export function formatClipboardTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) {
    return "Just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffMins < 1440) {
    return `${Math.floor(diffMins / 60)}h ago`;
  }
  return `${Math.floor(diffMins / 1440)}d ago`;
}
