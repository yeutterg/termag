import type { Project } from "../components/types";

type TabPatch = {
  id: string;
  status?: string;
  runtimeTabStatus?: string;
  focused?: boolean;
};

type ProjectPatch = {
  id: string;
  status?: string;
  runtimeFocused?: boolean;
  tabs?: TabPatch[];
};

export type LiveInventoryPatch = {
  type: "inventory-patch";
  revision?: number;
  projects: ProjectPatch[];
};

const MAX_PROJECT_PATCHES = 512;
const MAX_TAB_PATCHES = 4096;

/** Apply status/focus-only inventory updates without downloading the full tree. */
export function applyLiveInventoryPatch(projects: Project[], input: unknown): Project[] {
  const patch = parsePatch(input);
  if (!patch) {
    return projects;
  }
  const byProject = new Map(patch.projects.map(project => [project.id, project]));
  let anyChanged = false;
  const next = projects.map(project => {
    const update = byProject.get(project.id);
    if (!update) {
      return project;
    }
    const byTab = new Map((update.tabs ?? []).map(tab => [tab.id, tab]));
    let projectChanged =
      (update.status !== undefined && update.status !== project.status) ||
      (update.runtimeFocused !== undefined && update.runtimeFocused !== project.runtimeFocused);
    const tabs = byTab.size
      ? project.tabs.map(tab => {
          const tabUpdate = byTab.get(tab.id);
          if (!tabUpdate) {
            return tab;
          }
          const tabChanged =
            (tabUpdate.status !== undefined && tabUpdate.status !== tab.status) ||
            (tabUpdate.runtimeTabStatus !== undefined &&
              tabUpdate.runtimeTabStatus !== tab.runtimeTabStatus) ||
            (tabUpdate.focused !== undefined && tabUpdate.focused !== tab.focused);
          if (!tabChanged) {
            return tab;
          }
          projectChanged = true;
          const status = tabUpdate.status ?? tab.status;
          return {
            ...tab,
            status,
            ...(tabUpdate.runtimeTabStatus !== undefined
              ? { runtimeTabStatus: tabUpdate.runtimeTabStatus }
              : {}),
            ...(tabUpdate.focused !== undefined ? { focused: tabUpdate.focused } : {}),
            ...(tab.session ? { session: { ...tab.session, status } } : {}),
          };
        })
      : project.tabs;
    if (!projectChanged) {
      return project;
    }
    anyChanged = true;
    return {
      ...project,
      tabs,
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.runtimeFocused !== undefined ? { runtimeFocused: update.runtimeFocused } : {}),
    };
  });
  return anyChanged ? next : projects;
}

function parsePatch(input: unknown): LiveInventoryPatch | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const raw = input as Record<string, unknown>;
  if (raw.type !== "inventory-patch" || !Array.isArray(raw.projects)) {
    return null;
  }
  if (raw.projects.length > MAX_PROJECT_PATCHES) {
    return null;
  }
  let tabCount = 0;
  const projects: ProjectPatch[] = [];
  for (const candidate of raw.projects) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const project = candidate as Record<string, unknown>;
    if (typeof project.id !== "string") {
      return null;
    }
    const tabs: TabPatch[] = [];
    if (project.tabs !== undefined) {
      if (!Array.isArray(project.tabs)) {
        return null;
      }
      tabCount += project.tabs.length;
      if (tabCount > MAX_TAB_PATCHES) {
        return null;
      }
      for (const tabCandidate of project.tabs) {
        if (!tabCandidate || typeof tabCandidate !== "object") {
          return null;
        }
        const tab = tabCandidate as Record<string, unknown>;
        if (typeof tab.id !== "string") {
          return null;
        }
        tabs.push({
          id: tab.id,
          ...(typeof tab.status === "string" ? { status: tab.status } : {}),
          ...(typeof tab.runtimeTabStatus === "string"
            ? { runtimeTabStatus: tab.runtimeTabStatus }
            : {}),
          ...(typeof tab.focused === "boolean" ? { focused: tab.focused } : {}),
        });
      }
    }
    projects.push({
      id: project.id,
      ...(typeof project.status === "string" ? { status: project.status } : {}),
      ...(typeof project.runtimeFocused === "boolean"
        ? { runtimeFocused: project.runtimeFocused }
        : {}),
      ...(tabs.length ? { tabs } : {}),
    });
  }
  return {
    type: "inventory-patch",
    projects,
    ...(Number.isFinite(Number(raw.revision)) ? { revision: Number(raw.revision) } : {}),
  };
}
