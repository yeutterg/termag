"use client";

import { useCallback, useMemo, useState } from "react";
import type { Project } from "./types";

type History = Record<string, string[]>;
const MAX_PROJECT_HISTORY = 64;
const MAX_TABS_PER_PROJECT = 32;

export type TabHistory = {
  /** Pick which tab to fall back to after closing one. */
  nextRecent: (project: Project, excluded: string) => string | undefined;
  /** Record a tab as the most recently active. */
  remember: (projectId: string, tabId: string) => void;
};

export function useTabHistory(initial: History = {}): TabHistory {
  const [history, setHistory] = useState<History>(initial);

  const remember = useCallback((projectId: string, tabId: string) => {
    setHistory(current => {
      const recentTabs = [tabId, ...(current[projectId] ?? []).filter(id => id !== tabId)].slice(
        0,
        MAX_TABS_PER_PROJECT
      );
      // Reinsert the touched project at the end so object insertion order is
      // a real LRU order. Merely overwriting an existing property leaves it
      // in its old position and can either evict the active project or let
      // the map grow past the cap.
      const older = Object.entries(current)
        .filter(([id]) => id !== projectId)
        .slice(-(MAX_PROJECT_HISTORY - 1));
      return Object.fromEntries([...older, [projectId, recentTabs]]);
    });
  }, []);

  const nextRecent = useCallback(
    (project: Project, excluded: string) => {
      const tabIds = project.tabs.map(tab => tab.id);
      const remembered = (history[project.id] ?? []).filter(id => tabIds.includes(id));
      const order = [...remembered, ...tabIds.filter(id => !remembered.includes(id))];
      return order.find(id => id !== excluded) ?? project.tabs.find(tab => tab.id !== excluded)?.id;
    },
    [history]
  );

  return useMemo(() => ({ nextRecent, remember }), [nextRecent, remember]);
}
