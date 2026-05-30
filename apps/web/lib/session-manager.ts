export interface Tab {
  id: string;
  name: string;
  projectId: string;
  sessionId: string;
  isActive: boolean;
  isPinned: boolean;
  splitDirection?: "horizontal" | "vertical";
  splitFrom?: string;
}

export interface SessionState {
  tabs: Tab[];
  activeTabId: string | null;
  closedTabs: Tab[];
}

const SESSION_STATE_KEY = "termag-session-state";

/**
 * Get session state from localStorage
 */
export function getSessionState(): SessionState {
  if (typeof window === "undefined") {
    return { tabs: [], activeTabId: null, closedTabs: [] };
  }

  try {
    const stored = localStorage.getItem(SESSION_STATE_KEY);
    return stored ? JSON.parse(stored) : { tabs: [], activeTabId: null, closedTabs: [] };
  } catch (error) {
    console.error("Failed to load session state:", error);
    return { tabs: [], activeTabId: null, closedTabs: [] };
  }
}

/**
 * Save session state to localStorage
 */
export function saveSessionState(state: SessionState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to save session state:", error);
  }
}

/**
 * Create a new tab
 */
export function createTab(projectId: string, name: string = "New Tab"): Tab {
  return {
    id: `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    name,
    projectId,
    sessionId: `session-${Date.now()}`,
    isActive: false,
    isPinned: false,
  };
}

/**
 * Add tab to session state
 */
export function addTab(tab: Tab): SessionState {
  const state = getSessionState();
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  saveSessionState(state);
  return state;
}

/**
 * Switch to a specific tab
 */
export function switchTab(tabId: string): SessionState {
  const state = getSessionState();
  state.tabs = state.tabs.map(tab => ({
    ...tab,
    isActive: tab.id === tabId,
  }));
  state.activeTabId = tabId;
  saveSessionState(state);
  return state;
}

/**
 * Close a tab
 */
export function closeTab(tabId: string): SessionState {
  const state = getSessionState();
  const tabToClose = state.tabs.find(t => t.id === tabId);

  if (!tabToClose) {
    return state;
  }

  // Add to closed tabs for reopening
  state.closedTabs.unshift(tabToClose);
  // Keep only last 20 closed tabs
  if (state.closedTabs.length > 20) {
    state.closedTabs = state.closedTabs.slice(0, 20);
  }

  // Remove from active tabs
  state.tabs = state.tabs.filter(t => t.id !== tabId);

  // If we closed the active tab, switch to another
  if (state.activeTabId === tabId) {
    const remainingTabs = state.tabs.filter(t => !t.splitFrom); // Only root tabs
    if (remainingTabs.length > 0) {
      state.activeTabId = remainingTabs[0].id;
      state.tabs = state.tabs.map(t => ({
        ...t,
        isActive: t.id === remainingTabs[0].id,
      }));
    } else {
      state.activeTabId = null;
    }
  }

  saveSessionState(state);
  return state;
}

/**
 * Reopen the last closed tab
 */
export function reopenLastClosedTab(): SessionState | null {
  const state = getSessionState();

  if (state.closedTabs.length === 0) {
    return null;
  }

  const reopenedTab = state.closedTabs.shift();
  if (!reopenedTab) {
    return null;
  }

  reopenedTab.isActive = true;
  state.tabs.push(reopenedTab);
  state.activeTabId = reopenedTab.id;

  // Deactivate other tabs
  state.tabs = state.tabs.map(t => ({
    ...t,
    isActive: t.id === reopenedTab.id,
  }));

  saveSessionState(state);
  return state;
}

/**
 * Split a tab horizontally or vertically
 */
export function splitTab(tabId: string, direction: "horizontal" | "vertical"): SessionState {
  const state = getSessionState();
  const parentTab = state.tabs.find(t => t.id === tabId);

  if (!parentTab) {
    return state;
  }

  const newTab = createTab(parentTab.projectId, `${parentTab.name} (split)`);
  newTab.splitDirection = direction;
  newTab.splitFrom = tabId;

  state.tabs.push(newTab);
  saveSessionState(state);
  return state;
}

/**
 * Pin a tab
 */
export function pinTab(tabId: string): SessionState {
  const state = getSessionState();
  state.tabs = state.tabs.map(tab => {
    if (tab.id === tabId) {
      return { ...tab, isPinned: !tab.isPinned };
    }
    return tab;
  });
  saveSessionState(state);
  return state;
}

/**
 * Rename a tab
 */
export function renameTab(tabId: string, newName: string): SessionState {
  const state = getSessionState();
  state.tabs = state.tabs.map(tab => {
    if (tab.id === tabId) {
      return { ...tab, name: newName };
    }
    return tab;
  });
  saveSessionState(state);
  return state;
}

/**
 * Get tabs for a specific project
 */
export function getProjectTabs(projectId: string): Tab[] {
  const state = getSessionState();
  return state.tabs.filter(t => t.projectId === projectId && !t.splitFrom);
}

/**
 * Get all tabs in a split pane hierarchy
 */
export function getTabHierarchy(tabId: string): Tab[] {
  const state = getSessionState();
  const hierarchy: Tab[] = [];

  const collectChildren = (parentId: string) => {
    const children = state.tabs.filter(t => t.splitFrom === parentId);
    children.forEach(child => {
      hierarchy.push(child);
      collectChildren(child.id);
    });
  };

  const tab = state.tabs.find(t => t.id === tabId);
  if (tab) {
    hierarchy.push(tab);
    collectChildren(tabId);
  }

  return hierarchy;
}
