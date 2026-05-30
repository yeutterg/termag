'use client';

import { useEffect, useRef, useState } from 'react';

// Per-session "notify me when idle / done / errored" hook. The dashboard
// already gets status updates over the /api/ws/status channel; we just
// observe transitions from "working"/"waiting" → "idle"/"error" and
// trigger Browser notifications for sessions the user has opted in.
//
// State lives in localStorage so it survives reloads but doesn't ping
// back to the server — purely a per-browser preference.

const STORAGE_KEY = 'termag.notify.subscribed.v1';

type SessionStatus = 'idle' | 'working' | 'waiting' | 'error' | 'sleeping' | string;

function readSubscribed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSubscribed(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

export function useSessionNotifications(opts: {
  tabSnapshots: Array<{ projectName: string; tabName: string; tabId: string; status: SessionStatus }>;
}) {
  const [subscribed, setSubscribed] = useState<Set<string>>(() => (typeof window === 'undefined' ? new Set() : readSubscribed()));
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (!notificationsSupported()) return 'unsupported';
    return Notification.permission;
  });
  // Previous status snapshot keyed by tabId, used to detect transitions.
  const prevStatusRef = useRef<Map<string, SessionStatus>>(new Map());

  // Fire on transition into a "done-ish" state.
  useEffect(() => {
    if (permission !== 'granted') {
      prevStatusRef.current = new Map(opts.tabSnapshots.map((t) => [t.tabId, t.status]));
      return;
    }
    const prev = prevStatusRef.current;
    for (const tab of opts.tabSnapshots) {
      const last = prev.get(tab.tabId);
      const wasBusy = last === 'working' || last === 'waiting';
      // 'waiting' is now a "needs you" terminal-ish state (BEL / blocking on
      // input), so it counts as final alongside idle/error. Guarding on
      // last !== tab.status keeps 'waiting' → 'waiting' from re-firing, so a
      // bell that keeps mapping to 'waiting' only notifies once on entry.
      const nowFinal = tab.status === 'idle' || tab.status === 'error' || tab.status === 'waiting';
      if (wasBusy && nowFinal && last !== tab.status && subscribed.has(tab.tabId)) {
        try {
          const title =
            tab.status === 'error'
              ? `❌ ${tab.projectName}: ${tab.tabName}`
              : tab.status === 'waiting'
                ? `🔔 ${tab.projectName}: ${tab.tabName}`
                : `✓ ${tab.projectName}: ${tab.tabName}`;
          const body =
            tab.status === 'error'
              ? 'Session reported an error.'
              : tab.status === 'waiting'
                ? 'Session needs your input.'
                : 'Session is idle.';
          new Notification(title, { body, tag: `termag.session.${tab.tabId}`, silent: false });
        } catch {
          // Some platforms throw on rapid duplicate notifications.
        }
      }
    }
    prevStatusRef.current = new Map(opts.tabSnapshots.map((t) => [t.tabId, t.status]));
  }, [opts.tabSnapshots, permission, subscribed]);

  async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!notificationsSupported()) return 'unsupported';
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch {
      return Notification.permission;
    }
  }

  function toggle(tabId: string): boolean {
    const next = new Set(subscribed);
    const wasOn = next.has(tabId);
    if (wasOn) next.delete(tabId);
    else next.add(tabId);
    setSubscribed(next);
    writeSubscribed(next);
    return !wasOn;
  }

  return { permission, requestPermission, subscribed, toggle };
}
