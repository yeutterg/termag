/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */

export interface OfflineAction {
  id: string;
  type: string;
  data: any;
  timestamp: string;
}

const OFFLINE_ACTIONS_KEY = "termag-offline-actions";
const OFFLINE_STATUS_KEY = "termag-offline-status";

/**
 * Check if the browser is online
 */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") {
    return true;
  }
  return navigator.onLine;
}

/**
 * Get offline status from localStorage
 */
export function getOfflineStatus(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const stored = localStorage.getItem(OFFLINE_STATUS_KEY);
    return stored === "true";
  } catch {
    return false;
  }
}

/**
 * Set offline status
 */
export function setOfflineStatus(offline: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(OFFLINE_STATUS_KEY, String(offline));
  } catch (error) {
    console.error("Failed to set offline status:", error);
  }
}

/**
 * Queue an action for when we go back online
 */
export function queueOfflineAction(type: string, data: any): string {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const actions = getQueuedActions();
    const action: OfflineAction = {
      id: `action-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      timestamp: new Date().toISOString(),
    };

    actions.push(action);
    localStorage.setItem(OFFLINE_ACTIONS_KEY, JSON.stringify(actions));

    return action.id;
  } catch (error) {
    console.error("Failed to queue offline action:", error);
    return "";
  }
}

/**
 * Get all queued offline actions
 */
export function getQueuedActions(): OfflineAction[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(OFFLINE_ACTIONS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Clear queued offline actions
 */
export function clearQueuedActions(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(OFFLINE_ACTIONS_KEY);
  } catch (error) {
    console.error("Failed to clear queued actions:", error);
  }
}

/**
 * Remove a specific queued action
 */
export function removeQueuedAction(actionId: string): void {
  const actions = getQueuedActions();
  const filtered = actions.filter(a => a.id !== actionId);

  try {
    localStorage.setItem(OFFLINE_ACTIONS_KEY, JSON.stringify(filtered));
  } catch (error) {
    console.error("Failed to remove queued action:", error);
  }
}

/**
 * Process queued actions when back online
 */
export async function processQueuedActions(
  processor: (type: string, data: any) => Promise<void>
): Promise<void> {
  const actions = getQueuedActions();

  for (const action of actions) {
    try {
      await processor(action.type, action.data);
      removeQueuedAction(action.id);
    } catch (error) {
      console.error(`Failed to process action ${action.id}:`, error);
    }
  }
}

/**
 * Register online/offline event listeners
 */
export function registerNetworkListeners(
  onOnline?: () => void,
  onOffline?: () => void
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleOnline = () => {
    setOfflineStatus(false);
    onOnline?.();
  };

  const handleOffline = () => {
    setOfflineStatus(true);
    onOffline?.();
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
}

/**
 * Register service worker
 */
export async function registerServiceWorker(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    console.log("Service worker registered:", registration);
  } catch (error) {
    console.error("Service worker registration failed:", error);
  }
}
