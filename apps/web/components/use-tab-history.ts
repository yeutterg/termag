'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Project } from './types';

type History = Record<string, string[]>;

export type TabHistory = {
  /** Pick which tab to fall back to after closing one. */
  nextRecent: (project: Project, excluded: string) => string | undefined;
  /** Record a tab as the most recently active. */
  remember: (projectId: string, tabId: string) => void;
  /** Cycle through tab history (Ctrl+Tab / Ctrl+Shift+Tab). */
  cycle: (project: Project, currentTabId: string, reverse: boolean) => string | undefined;
};

export function useTabHistory(initial: History = {}): TabHistory {
  const [history, setHistory] = useState<History>(initial);

  const remember = useCallback((projectId: string, tabId: string) => {
    setHistory((current) => ({
      ...current,
      [projectId]: [tabId, ...(current[projectId] ?? []).filter((id) => id !== tabId)]
    }));
  }, []);

  // Newest-first list of tab ids that still exist in the project, padded with
  // any unseen tabs so we never miss one.
  const orderFor = useCallback((project: Project): string[] => {
    const tabIds = project.tabs.map((tab) => tab.id);
    const remembered = (history[project.id] ?? []).filter((id) => tabIds.includes(id));
    return [...remembered, ...tabIds.filter((id) => !remembered.includes(id))];
  }, [history]);

  const nextRecent = useCallback((project: Project, excluded: string) => {
    return orderFor(project).find((id) => id !== excluded) ?? project.tabs.find((tab) => tab.id !== excluded)?.id;
  }, [orderFor]);

  const cycle = useCallback((project: Project, currentTabId: string, reverse: boolean) => {
    const order = orderFor(project);
    if (order.length <= 1) return undefined;
    const currentIndex = Math.max(0, order.indexOf(currentTabId));
    const nextIndex = reverse
      ? (currentIndex - 1 + order.length) % order.length
      : (currentIndex + 1) % order.length;
    return order[nextIndex];
  }, [orderFor]);

  return useMemo(() => ({ nextRecent, remember, cycle }), [nextRecent, remember, cycle]);
}
