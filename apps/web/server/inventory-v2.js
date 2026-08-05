const MAX_RUNTIME_SESSIONS = 128;
const MAX_SPACES = 512;
const MAX_TABS = 2048;
const MAX_PANES = 4096;
const VALID_STATUSES = new Set(["blocked", "working", "done", "idle", "unknown", "offline"]);

function text(value, fallback = "", max = 512) {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\x00-\x1F\x7F-\x9F]/g, " ").trim();
  return clean.slice(0, max) || fallback;
}

function status(value) {
  return VALID_STATUSES.has(value) ? value : "unknown";
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeSnapshot(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const runtimes = [];
  let sessionCount = 0;
  let spaceCount = 0;
  let tabCount = 0;
  let paneCount = 0;
  for (const runtime of Array.isArray(source.runtimes) ? source.runtimes : []) {
    const kind = runtime?.kind === "herdr" ? "herdr" : runtime?.kind === "tmux" ? "tmux" : null;
    if (!kind) continue;
    const sessions = [];
    for (const rawSession of Array.isArray(runtime.sessions) ? runtime.sessions : []) {
      if (++sessionCount > MAX_RUNTIME_SESSIONS)
        throw new Error("inventory session limit exceeded");
      const id = text(rawSession?.id, "", 256);
      if (!id) continue;
      const spaces = [];
      for (const rawSpace of Array.isArray(rawSession.spaces) ? rawSession.spaces : []) {
        if (++spaceCount > MAX_SPACES) throw new Error("inventory space limit exceeded");
        const spaceId = text(rawSpace?.id, "", 256);
        if (!spaceId) continue;
        const tabs = [];
        for (const rawTab of Array.isArray(rawSpace.tabs) ? rawSpace.tabs : []) {
          if (++tabCount > MAX_TABS) throw new Error("inventory tab limit exceeded");
          const tabId = text(rawTab?.id, "", 256);
          if (!tabId) continue;
          const panes = [];
          for (const rawPane of Array.isArray(rawTab.panes) ? rawTab.panes : []) {
            if (++paneCount > MAX_PANES) throw new Error("inventory pane limit exceeded");
            const paneId = text(rawPane?.id, "", 256);
            if (!paneId) continue;
            panes.push({
              id: paneId,
              terminalId: text(rawPane?.terminalId, paneId, 256),
              name: text(rawPane?.name, "Terminal", 160),
              ordinal: integer(rawPane?.ordinal, panes.length),
              status: status(rawPane?.status),
              focused: Boolean(rawPane?.focused),
              cwd: text(rawPane?.cwd, "", 2048) || null,
              command: text(rawPane?.command, "", 256) || null,
              agent: text(rawPane?.agent, "", 80) || null,
            });
          }
          tabs.push({
            id: tabId,
            name: text(rawTab?.name, "Terminal", 160),
            ordinal: integer(rawTab?.ordinal, tabs.length),
            status: status(rawTab?.status),
            focused: Boolean(rawTab?.focused),
            layout: rawTab?.layout && typeof rawTab.layout === "object" ? rawTab.layout : null,
            panes,
          });
        }
        spaces.push({
          id: spaceId,
          name: text(rawSpace?.name, kind === "tmux" ? id : "Space", 160),
          ordinal: integer(rawSpace?.ordinal, spaces.length),
          status: status(rawSpace?.status),
          focused: Boolean(rawSpace?.focused),
          activeTabId: text(rawSpace?.activeTabId, "", 256) || null,
          tabs,
        });
      }
      sessions.push({
        id,
        name: text(rawSession?.name, id, 160),
        version: text(rawSession?.version, "", 80) || null,
        statusIndicators: rawSession?.statusIndicators === "symbols" ? "symbols" : "dots",
        path: text(rawSession?.path, "", 2048) || null,
        status: status(rawSession?.status),
        spaces,
      });
    }
    runtimes.push({ kind, available: Boolean(runtime.available), sessions });
  }
  return {
    revision: Math.max(0, integer(source.revision)),
    roots: Array.isArray(source.roots) ? source.roots.slice(0, 128) : [],
    runtimes,
  };
}

async function uniqueProjectName(prisma, userId, wanted, existingId) {
  const base = text(wanted, "Workspace", 80);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : ` (${index + 1})`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    const conflict = await prisma.project.findFirst({
      where: { userId, name: candidate, ...(existingId ? { NOT: { id: existingId } } : {}) },
      select: { id: true },
    });
    if (!conflict) return candidate;
  }
  return `${base.slice(0, 64)} ${Date.now().toString(36)}`;
}

function paneLabel(tab, pane) {
  if (tab.panes.length <= 1) return tab.name;
  const paneName = pane.name === "Terminal" ? `Pane ${pane.ordinal + 1}` : pane.name;
  return `${tab.name} · ${paneName}`.slice(0, 160);
}

async function reconcileInventory({ prisma, userId, deviceId, deviceName, rawSnapshot }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const seenProjects = new Set();
  const mirroredAt = new Date();

  for (const runtime of snapshot.runtimes) {
    for (const runtimeSession of runtime.sessions) {
      for (const space of runtimeSession.spaces) {
        const firstPaneCwd = space.tabs
          .flatMap(tab => tab.panes)
          .map(pane => pane.cwd)
          .find(Boolean);
        let project = await prisma.project.findFirst({
          where: {
            userId,
            deviceId,
            runtime: runtime.kind,
            runtimeSessionId: runtimeSession.id,
            externalId: space.id,
          },
        });
        if (!project && runtime.kind === "tmux") {
          const windowIds = space.tabs.map(tab => tab.id).filter(Boolean);
          if (windowIds.length) {
            project = await prisma.project.findFirst({
              where: {
                userId,
                rootKey: deviceName,
                sessions: { some: { tmuxName: { in: windowIds } } },
              },
            });
          }
        }
        if (!project && runtime.kind === "tmux") {
          project = await prisma.project.findFirst({
            where: { userId, rootKey: deviceName, tmuxSessionName: runtimeSession.name },
          });
        }
        const projectName = await uniqueProjectName(prisma, userId, space.name, project?.id);
        const projectData = {
          name: projectName,
          rootKey: deviceName,
          relativePath:
            runtime.kind === "tmux"
              ? `tmux/${runtimeSession.name}`
              : `herdr/${runtimeSession.name}/${space.name}`,
          tmuxSessionName: runtime.kind === "tmux" ? runtimeSession.id : null,
          tmuxManaged: false,
          agentType: runtime.kind,
          agentSpawnCommand: "$SHELL",
          status: space.status,
          deviceId,
          runtime: runtime.kind,
          runtimeSessionId: runtimeSession.id,
          runtimeSessionName: runtimeSession.name,
          runtimeSpaceName: space.name,
          runtimeIconStyle: runtime.kind === "herdr" ? runtimeSession.statusIndicators : null,
          runtimeOrdinal: space.ordinal,
          runtimeFocused: space.focused,
          externalId: space.id,
          runtimeRevision: snapshot.revision,
          creationPath: firstPaneCwd || runtimeSession.path,
          mirrored: true,
          archivedAt: null,
        };
        project = project
          ? await prisma.project.update({ where: { id: project.id }, data: projectData })
          : await prisma.project.create({ data: { ...projectData, userId } });
        seenProjects.add(project.id);
        const seenTabs = new Set();

        for (const runtimeTab of space.tabs) {
          for (const pane of runtimeTab.panes) {
            let tab = await prisma.tab.findFirst({
              where: { projectId: project.id, runtimePaneId: pane.id },
              include: { session: true },
            });
            if (!tab && runtime.kind === "tmux") {
              tab = await prisma.tab.findFirst({
                where: {
                  projectId: project.id,
                  runtimePaneId: null,
                  session: { tmuxName: runtimeTab.id },
                },
                include: { session: true },
              });
            }
            const ordinal = runtimeTab.ordinal * 10_000 + pane.ordinal;
            const tabData = {
              name: paneLabel(runtimeTab, pane),
              ordinal,
              status: pane.status,
              externalId: runtimeTab.id,
              runtimeTabId: runtimeTab.id,
              runtimeTabName: runtimeTab.name,
              runtimeTabStatus: runtimeTab.status,
              runtimePaneId: pane.id,
              runtimePaneName: pane.name,
              runtimePaneIndex: pane.ordinal,
              layout: runtimeTab.layout ? JSON.stringify(runtimeTab.layout) : null,
              focused:
                pane.focused ||
                (runtimeTab.id === space.activeTabId &&
                  pane.ordinal === runtimeTab.panes[0]?.ordinal),
              archivedAt: null,
            };
            if (tab) {
              tab = await prisma.tab.update({
                where: { id: tab.id },
                data: {
                  ...tabData,
                  session: tab.session
                    ? {
                        update: {
                          tmuxName: runtime.kind === "tmux" ? runtimeTab.id : pane.id,
                          tmuxWindowName: runtimeTab.name,
                          status: pane.status,
                          lastSeenAt: mirroredAt,
                          runtime: runtime.kind,
                          runtimeSessionId: runtimeSession.id,
                          externalId: pane.id,
                          terminalId: pane.terminalId,
                          archivedAt: null,
                        },
                      }
                    : {
                        create: sessionData(runtime, runtimeSession, runtimeTab, pane, project.id),
                      },
                },
                include: { session: true },
              });
            } else {
              tab = await prisma.tab.create({
                data: {
                  ...tabData,
                  projectId: project.id,
                  session: {
                    create: sessionData(runtime, runtimeSession, runtimeTab, pane, project.id),
                  },
                },
                include: { session: true },
              });
            }
            seenTabs.add(tab.id);
          }
        }
        await prisma.tab.updateMany({
          where: {
            projectId: project.id,
            runtimePaneId: { not: null },
            ...(seenTabs.size ? { id: { notIn: [...seenTabs] } } : {}),
          },
          data: { archivedAt: mirroredAt, status: "offline" },
        });
        await prisma.session.updateMany({
          where: {
            projectId: project.id,
            externalId: { not: null },
            tabId: { notIn: [...seenTabs] },
          },
          data: { archivedAt: mirroredAt, status: "offline" },
        });
      }
    }
  }

  await prisma.project.updateMany({
    where: {
      userId,
      deviceId,
      mirrored: true,
      ...(seenProjects.size ? { id: { notIn: [...seenProjects] } } : {}),
    },
    data: { archivedAt: mirroredAt, status: "offline" },
  });
  await prisma.agentToken.update({
    where: { id: deviceId },
    data: { protocolVersion: 2, lastInventoryAt: mirroredAt },
  });
  return snapshot;
}

function sessionData(runtime, runtimeSession, runtimeTab, pane, projectId) {
  return {
    projectId,
    kind: "agent",
    tmuxName: runtime.kind === "tmux" ? runtimeTab.id : pane.id,
    tmuxWindowName: runtimeTab.name,
    tmuxManaged: false,
    agentType: runtime.kind,
    status: pane.status,
    lastSeenAt: new Date(),
    runtime: runtime.kind,
    runtimeSessionId: runtimeSession.id,
    externalId: pane.id,
    terminalId: pane.terminalId,
    controllerMode: "observe",
    archivedAt: null,
  };
}

module.exports = { normalizeSnapshot, reconcileInventory };
