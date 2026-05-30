// Usability utilities for termag

/**
 * Debounce function for performance optimization
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Throttle function for rate limiting
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Format time duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3600000) {
    return `${Math.round(ms / 60000)}m`;
  }
  return `${Math.round(ms / 3600000)}h`;
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Generate keyboard shortcut hint
 */
export function shortcutHint(keys: string[]): string {
  return keys
    .map(key => {
      // Convert common keys to display format
      if (key === "Meta") {
        return "⌘";
      }
      if (key === "Control") {
        return "⌃";
      }
      if (key === "Alt") {
        return "⌥";
      }
      if (key === "Shift") {
        return "⇧";
      }
      if (key === "Enter") {
        return "↵";
      }
      if (key === "Escape") {
        return "⎋";
      }
      if (key === "Backspace") {
        return "⌫";
      }
      if (key === "Tab") {
        return "⇥";
      }
      return key.toUpperCase();
    })
    .join("");
}

/**
 * Get platform-specific modifier key
 */
export function getModifierKey(): string {
  if (typeof window !== "undefined") {
    return navigator.platform.toLowerCase().includes("mac") ? "⌘" : "⌃";
  }
  return "⌃";
}

/**
 * Parse keyboard event for shortcuts
 */
export function parseShortcut(event: KeyboardEvent): string {
  const parts: string[] = [];

  if (event.metaKey) {
    parts.push("Meta");
  }
  if (event.ctrlKey) {
    parts.push("Control");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  parts.push(event.key);

  return parts.join("+");
}

/**
 * Check if keyboard event matches shortcut
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const eventShortcut = parseShortcut(event);
  return eventShortcut.toLowerCase() === shortcut.toLowerCase();
}

/**
 * Copy text to clipboard with fallback
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    // Fallback for older browsers
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
      document.body.removeChild(textArea);
      return true;
    } catch {
      document.body.removeChild(textArea);
      return false;
    }
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return false;
  }
}

/**
 * Paste from clipboard with fallback
 */
export async function pasteFromClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return await navigator.clipboard.readText();
    }

    // Fallback for older browsers
    const textArea = document.createElement("textarea");
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand("paste");
      const text = textArea.value;
      document.body.removeChild(textArea);
      return text;
    } catch {
      document.body.removeChild(textArea);
      return null;
    }
  } catch (error) {
    console.error("Failed to paste from clipboard:", error);
    return null;
  }
}

/**
 * Get safe area for mobile devices
 */
export function getSafeAreaInsets(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (typeof window !== "undefined" && window.getComputedStyle) {
    const style = window.getComputedStyle(document.documentElement);
    return {
      top: parseFloat(style.paddingTop) || 0,
      right: parseFloat(style.paddingRight) || 0,
      bottom: parseFloat(style.paddingBottom) || 0,
      left: parseFloat(style.paddingLeft) || 0,
    };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/**
 * Check if device is mobile
 */
export function isMobile(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

/**
 * Check if device supports touch
 */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

/**
 * Format number with locale
 */
export function formatNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(num);
}

/**
 * Generate unique ID
 */
export function generateId(prefix: string = "id"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Local storage wrapper with error handling
 */
export const storage = {
  get<T>(key: string): T | null {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.error("Failed to get from localStorage:", error);
      return null;
    }
  },

  set<T>(key: string, value: T): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error("Failed to set localStorage:", error);
      return false;
    }
  },

  remove(key: string): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.error("Failed to remove from localStorage:", error);
      return false;
    }
  },
};

/**
 * Session storage wrapper
 */
export const sessionStorage = {
  get<T>(key: string): T | null {
    if (typeof window === "undefined") {
      return null;
    }
    try {
      const item = window.sessionStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.error("Failed to get from sessionStorage:", error);
      return null;
    }
  },

  set<T>(key: string, value: T): boolean {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error("Failed to set sessionStorage:", error);
      return false;
    }
  },
};
