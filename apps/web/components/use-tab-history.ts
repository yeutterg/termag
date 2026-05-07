'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Project } from './types';

type History = Record<string, string[]>;

export type TabHistory = {
  /** Pick which tab to fall back to after closing one. */
  nextRecent: (project: Project, excluded: string) => string | undefined;
  /** Record a tab as the most recently active. */
  remember: (projectId: string, tabId: string) => void;
};

export function useTabHistory(initial: History = {}): TabHistory {
  const [history, setHistory] = useState<History>(initial);

  const remember = useCallback((projectId: string, tabId: string) => {
    setHistory((current) => ({
      ...current,
      [projectId]: [tabId, ...(current[projectId] ?? []).filter((id) => id !== tabId)]
    }));
  }, []);

  const nextRecent = useCallback((project: Project, excluded: string) => {
    const tabIds = project.tabs.map((tab) => tab.id);
    const remembered = (history[project.id] ?? []).filter((id) => tabIds.includes(id));
    const order = [...remembered, ...tabIds.filter((id) => !remembered.includes(id))];
    return order.find((id) => id !== excluded) ?? project.tabs.find((tab) => tab.id !== excluded)?.id;
  }, [history]);

  return useMemo(() => ({ nextRecent, remember }), [nextRecent, remember]);
}
