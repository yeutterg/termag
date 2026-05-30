export interface WindowState {
  focusedElement: "terminal" | "file-explorer" | "sidebar" | "none";
  isFullscreen: boolean;
  sidebarVisible: boolean;
  sidebarWidth: number;
}

const WINDOW_STATE_KEY = "termag-window-state";

/**
 * Get window state from localStorage
 */
export function getWindowState(): WindowState {
  if (typeof window === "undefined") {
    return {
      focusedElement: "terminal",
      isFullscreen: false,
      sidebarVisible: true,
      sidebarWidth: 250,
    };
  }

  try {
    const stored = localStorage.getItem(WINDOW_STATE_KEY);
    return stored
      ? JSON.parse(stored)
      : {
          focusedElement: "terminal",
          isFullscreen: false,
          sidebarVisible: true,
          sidebarWidth: 250,
        };
  } catch (error) {
    console.error("Failed to load window state:", error);
    return {
      focusedElement: "terminal",
      isFullscreen: false,
      sidebarVisible: true,
      sidebarWidth: 250,
    };
  }
}

/**
 * Save window state to localStorage
 */
export function saveWindowState(state: WindowState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to save window state:", error);
  }
}

/**
 * Focus terminal
 */
export function focusTerminal(): WindowState {
  const state = getWindowState();
  state.focusedElement = "terminal";
  saveWindowState(state);
  return state;
}

/**
 * Focus file explorer
 */
export function focusFileExplorer(): WindowState {
  const state = getWindowState();
  state.focusedElement = "file-explorer";
  saveWindowState(state);
  return state;
}

/**
 * Focus sidebar
 */
export function focusSidebar(): WindowState {
  const state = getWindowState();
  state.focusedElement = "sidebar";
  saveWindowState(state);
  return state;
}

/**
 * Toggle fullscreen
 */
export function toggleFullscreen(): WindowState {
  const state = getWindowState();
  state.isFullscreen = !state.isFullscreen;

  if (state.isFullscreen && typeof document !== "undefined") {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  } else if (typeof document !== "undefined") {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }

  saveWindowState(state);
  return state;
}

/**
 * Toggle sidebar
 */
export function toggleSidebar(): WindowState {
  const state = getWindowState();
  state.sidebarVisible = !state.sidebarVisible;
  saveWindowState(state);
  return state;
}

/**
 * Set sidebar width
 */
export function setSidebarWidth(width: number): WindowState {
  const state = getWindowState();
  state.sidebarWidth = width;
  saveWindowState(state);
  return state;
}

/**
 * Get current focused element
 */
export function getFocusedElement(): WindowState["focusedElement"] {
  return getWindowState().focusedElement;
}

/**
 * Check if fullscreen
 */
export function isFullscreenActive(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return !!document.fullscreenElement;
}

/**
 * Focus element by key (keyboard shortcut)
 */
export function focusByKey(key: string): WindowState {
  const state = getWindowState();

  switch (key) {
    case "1":
      state.focusedElement = "terminal";
      break;
    case "2":
      state.focusedElement = "file-explorer";
      break;
    case "3":
      state.focusedElement = "sidebar";
      break;
    default:
      return state;
  }

  saveWindowState(state);
  return state;
}
