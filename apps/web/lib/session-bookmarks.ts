export interface SessionBookmark {
  id: string;
  sessionId: string;
  projectId: string;
  tabId: string;
  name: string;
  description?: string;
  createdAt: string;
  position: number; // For ordering
}

const BOOKMARKS_KEY = "termag-session-bookmarks";

/**
 * Get all bookmarks from localStorage
 */
export function getBookmarks(): SessionBookmark[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(BOOKMARKS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to load bookmarks:", error);
    return [];
  }
}

/**
 * Save bookmarks to localStorage
 */
export function saveBookmarks(bookmarks: SessionBookmark[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
  } catch (error) {
    console.error("Failed to save bookmarks:", error);
  }
}

/**
 * Create a bookmark
 */
export function createBookmark(
  bookmark: Omit<SessionBookmark, "id" | "createdAt" | "position">
): SessionBookmark {
  const bookmarks = getBookmarks();
  const maxPosition = bookmarks.length > 0 ? Math.max(...bookmarks.map(b => b.position)) : 0;

  const newBookmark: SessionBookmark = {
    ...bookmark,
    id: `bookmark-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
    position: maxPosition + 1,
  };

  bookmarks.push(newBookmark);
  saveBookmarks(bookmarks);
  return newBookmark;
}

/**
 * Update a bookmark
 */
export function updateBookmark(
  id: string,
  updates: Partial<Omit<SessionBookmark, "id" | "createdAt" | "position">>
): SessionBookmark | null {
  const bookmarks = getBookmarks();
  const index = bookmarks.findIndex(b => b.id === id);

  if (index === -1) {
    return null;
  }

  bookmarks[index] = { ...bookmarks[index], ...updates };
  saveBookmarks(bookmarks);
  return bookmarks[index];
}

/**
 * Delete a bookmark
 */
export function deleteBookmark(id: string): boolean {
  const bookmarks = getBookmarks();
  const filtered = bookmarks.filter(b => b.id !== id);

  if (filtered.length === bookmarks.length) {
    return false;
  }

  saveBookmarks(filtered);
  return true;
}

/**
 * Reorder bookmarks
 */
export function reorderBookmarks(bookmarkIds: string[]): void {
  const bookmarks = getBookmarks();
  const bookmarkMap = new Map(bookmarks.map(b => [b.id, b]));

  const reordered = bookmarkIds
    .map(id => bookmarkMap.get(id))
    .filter((b): b is SessionBookmark => b !== undefined)
    .map((b, index) => ({ ...b, position: index + 1 }));

  saveBookmarks(reordered);
}

/**
 * Get bookmarks for a specific session
 */
export function getSessionBookmarks(sessionId: string): SessionBookmark[] {
  const bookmarks = getBookmarks();
  return bookmarks.filter(b => b.sessionId === sessionId).sort((a, b) => a.position - b.position);
}
