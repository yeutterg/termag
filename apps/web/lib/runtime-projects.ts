import "server-only";
import type { AgentToken } from "@prisma/client";
import { prisma } from "./prisma";
import {
  decodeRuntimeId,
  runtimeProjectId,
  runtimeSessionId,
  runtimeTabId,
  type RuntimeIdentity,
} from "./runtime-id";
import type { Project, Tab } from "@/components/types";

type SnapshotPane = {
  id: string;
  terminalId: string;
  name: string;
  ordinal: number;
  status: string;
  focused: boolean;
  cwd?: string | null;
};
type SnapshotTab = {
  id: string;
  name: string;
  ordinal: number;
  status: string;
  focused: boolean;
  layout?: unknown;
  panes: SnapshotPane[];
};
type SnapshotSpace = {
  id: string;
  name: string;
  ordinal: number;
  status: string;
  focused: boolean;
  activeTabId?: string | null;
  tabs: SnapshotTab[];
};
type SnapshotSession = {
  id: string;
  name: string;
  path?: string | null;
  statusIndicators?: string | null;
  spaces: SnapshotSpace[];
};
type SnapshotRuntime = {
  kind: "herdr" | "tmux";
  available: boolean;
  sessions: SnapshotSession[];
};
type Snapshot = {
  revision: number;
  roots: Array<{ key: string; path: string; writable?: boolean }>;
  runtimes: SnapshotRuntime[];
};

type SnapshotToken = Pick<AgentToken, "id" | "name" | "inventorySnapshot">;

export async function listProjects(userId: string): Promise<Project[]> {
  const tokens = await prisma.agentToken.findMany({
    where: { userId, revokedAt: null, inventorySnapshot: { not: null } },
    select: {
      id: true,
      name: true,
      inventorySnapshot: true,
    },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
  return tokens.flatMap(projectsFromToken);
}

export async function findProject(userId: string, id: string): Promise<Project | null> {
  const identity = decodeRuntimeId(id, "project");
  if (!identity) {
    return null;
  }
  const token = await prisma.agentToken.findFirst({
    where: { id: identity.deviceId, userId, revokedAt: null },
    select: {
      id: true,
      name: true,
      inventorySnapshot: true,
    },
  });
  return token ? (projectsFromToken(token).find(project => project.id === id) ?? null) : null;
}

export async function findTab(userId: string, projectId: string, tabId: string) {
  const project = await findProject(userId, projectId);
  return project
    ? { project, tab: project.tabs.find(tab => tab.id === tabId) ?? null }
    : { project: null, tab: null };
}

export function identityForProject(project: Project): RuntimeIdentity | null {
  return decodeRuntimeId(project.id, "project");
}

export function identityForTab(tab: Tab): RuntimeIdentity | null {
  return decodeRuntimeId(tab.id, "tab");
}

function projectsFromToken(token: SnapshotToken): Project[] {
  const snapshot = parseSnapshot(token.inventorySnapshot);
  if (!snapshot) {
    return [];
  }
  const projects: Project[] = [];
  for (const runtime of snapshot.runtimes) {
    if (!runtime.available) {
      continue;
    }
    for (const runtimeSession of runtime.sessions) {
      for (const space of runtimeSession.spaces) {
        const cwd = firstCwd(space) || runtimeSession.path || null;
        const directory = resolveDirectory(snapshot, cwd);
        const projectIdentity: RuntimeIdentity = {
          deviceId: token.id,
          runtime: runtime.kind,
          runtimeSessionId: runtimeSession.id,
          spaceId: space.id,
        };
        const tabs = space.tabs.flatMap(runtimeTab => {
          const layout = runtimeTab.layout ? JSON.stringify(runtimeTab.layout) : null;
          return runtimeTab.panes.map((pane, paneOffset) => {
            const identity: RuntimeIdentity = {
              ...projectIdentity,
              tabId: runtimeTab.id,
              paneId: pane.id,
              terminalId: pane.terminalId || pane.id,
            };
            const name =
              runtimeTab.panes.length === 1
                ? runtimeTab.name
                : `${runtimeTab.name} · ${pane.name || `Pane ${paneOffset + 1}`}`;
            return {
              id: runtimeTabId(identity),
              name,
              ordinal: runtimeTab.ordinal * 10_000 + pane.ordinal,
              status: pane.status,
              runtimeTabId: runtimeTab.id,
              runtimeTabName: runtimeTab.name,
              runtimeTabStatus: runtimeTab.status,
              runtimePaneId: pane.id,
              runtimePaneName: pane.name,
              runtimePaneIndex: pane.ordinal,
              layout,
              focused:
                pane.focused ||
                (runtimeTab.id === space.activeTabId &&
                  pane.ordinal === runtimeTab.panes[0]?.ordinal),
              session: {
                id: runtimeSessionId(identity),
                status: pane.status,
              },
            } satisfies Tab;
          });
        });
        tabs.sort((left, right) => left.ordinal - right.ordinal);
        projects.push({
          id: runtimeProjectId(projectIdentity),
          name: space.name,
          rootKey: token.name,
          relativePath: directory?.relativePath ?? "",
          directoryRootKey: directory?.rootKey ?? null,
          status: space.status,
          tabs,
          deviceId: token.id,
          runtime: runtime.kind,
          runtimeSessionId: runtimeSession.id,
          runtimeSessionName: runtimeSession.name,
          runtimeSpaceName: space.name,
          runtimeIconStyle: runtime.kind === "herdr" ? runtimeSession.statusIndicators : null,
          runtimeOrdinal: space.ordinal,
          runtimeFocused: space.focused,
        });
      }
    }
  }
  return projects.sort((left, right) => {
    const runtimeOrder = Number(left.runtime !== "herdr") - Number(right.runtime !== "herdr");
    return (
      runtimeOrder ||
      (left.runtimeSessionName || "").localeCompare(right.runtimeSessionName || "") ||
      (left.runtimeOrdinal ?? 0) - (right.runtimeOrdinal ?? 0)
    );
  });
}

function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw || raw.length > 16 * 1024 * 1024) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Snapshot;
    return Array.isArray(value?.runtimes) && Array.isArray(value?.roots) ? value : null;
  } catch {
    return null;
  }
}

function firstCwd(space: SnapshotSpace): string | null {
  for (const tab of space.tabs) {
    for (const pane of tab.panes) {
      if (pane.cwd) {
        return pane.cwd;
      }
    }
  }
  return null;
}

function resolveDirectory(snapshot: Snapshot, cwd: string | null) {
  if (!cwd) {
    return null;
  }
  const candidates = snapshot.roots
    .filter(root => root.key && root.path)
    .sort((left, right) => right.path.length - left.path.length);
  for (const root of candidates) {
    const base = root.path.replace(/\/+$/, "");
    if (cwd === base) {
      return { rootKey: root.key, relativePath: "" };
    }
    if (cwd.startsWith(`${base}/`)) {
      return { rootKey: root.key, relativePath: cwd.slice(base.length + 1) };
    }
  }
  return null;
}
