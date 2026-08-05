const MAX_RUNTIME_SESSIONS = 128;
const MAX_SPACES = 512;
const MAX_TABS = 2048;
const MAX_PANES = 4096;
const VALID_STATUSES = new Set(["blocked", "working", "done", "idle", "unknown", "offline"]);

function text(value, fallback = "", max = 512) {
  if (typeof value !== "string") {
    return fallback;
  }
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
    if (!kind) {
      continue;
    }
    const sessions = [];
    for (const rawSession of Array.isArray(runtime.sessions) ? runtime.sessions : []) {
      if (++sessionCount > MAX_RUNTIME_SESSIONS) {
        throw new Error("inventory session limit exceeded");
      }
      const id = text(rawSession?.id, "", 256);
      if (!id) {
        continue;
      }
      const spaces = [];
      for (const rawSpace of Array.isArray(rawSession.spaces) ? rawSession.spaces : []) {
        if (++spaceCount > MAX_SPACES) {
          throw new Error("inventory space limit exceeded");
        }
        const spaceId = text(rawSpace?.id, "", 256);
        if (!spaceId) {
          continue;
        }
        const tabs = [];
        for (const rawTab of Array.isArray(rawSpace.tabs) ? rawSpace.tabs : []) {
          if (++tabCount > MAX_TABS) {
            throw new Error("inventory tab limit exceeded");
          }
          const tabId = text(rawTab?.id, "", 256);
          if (!tabId) {
            continue;
          }
          const panes = [];
          for (const rawPane of Array.isArray(rawTab.panes) ? rawTab.panes : []) {
            if (++paneCount > MAX_PANES) {
              throw new Error("inventory pane limit exceeded");
            }
            const paneId = text(rawPane?.id, "", 256);
            if (!paneId) {
              continue;
            }
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

function reserveProjectName(owners, wanted, existing) {
  const base = text(wanted, "Workspace", 80);
  if (existing && owners.get(existing.name) === existing.id) {
    owners.delete(existing.name);
  }
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : ` (${index + 1})`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    const owner = owners.get(candidate);
    if (!owner || owner === existing?.id) {
      owners.set(candidate, existing?.id || "pending");
      return candidate;
    }
  }
  const fallback = `${base.slice(0, 64)} ${Date.now().toString(36)}`;
  owners.set(fallback, existing?.id || "pending");
  return fallback;
}

function paneLabel(tab, pane) {
  if (tab.panes.length <= 1) {
    return tab.name;
  }
  const paneName = pane.name === "Terminal" ? `Pane ${pane.ordinal + 1}` : pane.name;
  return `${tab.name} · ${paneName}`.slice(0, 160);
}

async function reconcileInventory({ prisma, userId, deviceId, deviceName, rawSnapshot }) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const seenProjects = new Set();
  const mirroredAt = new Date();
  const observedKinds = new Set(
    snapshot.runtimes.filter(runtime => runtime.available).map(runtime => runtime.kind)
  );
  const [existingProjects, projectNames] = await Promise.all([
    prisma.project.findMany({
      where: {
        userId,
        OR: [{ deviceId }, { rootKey: deviceName }],
      },
      include: { tabs: { include: { session: true } } },
    }),
    prisma.project.findMany({ where: { userId }, select: { id: true, name: true } }),
  ]);
  const nameOwners = new Map(projectNames.map(project => [project.name, project.id]));
  const byIdentity = new Map();
  const tmuxByWindow = new Map();
  const tmuxBySession = new Map();
  for (const project of existingProjects) {
    if (project.deviceId && project.runtimeSessionId && project.externalId) {
      byIdentity.set(
        identityKey(
          project.deviceId,
          project.runtime,
          project.runtimeSessionId,
          project.externalId
        ),
        project
      );
    }
    if (project.rootKey === deviceName && project.tmuxSessionName) {
      tmuxBySession.set(project.tmuxSessionName, project);
    }
    if (project.rootKey === deviceName) {
      for (const tab of project.tabs) {
        if (tab.session?.tmuxName) {
          tmuxByWindow.set(tab.session.tmuxName, project);
        }
      }
    }
  }
  const claimedProjects = new Set();
  const patches = [];
  const deferredWrites = [];
  let structuralChanged = false;

  for (const runtime of snapshot.runtimes) {
    // An unavailable runtime means discovery failed, not that every local
    // workspace vanished. Preserve its previous mirror until a complete
    // snapshot arrives so a transient HerdR/tmux error cannot archive it.
    if (!runtime.available) {
      continue;
    }
    for (const runtimeSession of runtime.sessions) {
      for (const space of runtimeSession.spaces) {
        const firstPaneCwd = space.tabs
          .flatMap(tab => tab.panes)
          .map(pane => pane.cwd)
          .find(Boolean);
        const key = identityKey(deviceId, runtime.kind, runtimeSession.id, space.id);
        let project = byIdentity.get(key);
        if (!project && runtime.kind === "tmux") {
          for (const runtimeTab of space.tabs) {
            const candidate = tmuxByWindow.get(runtimeTab.id);
            if (candidate && !claimedProjects.has(candidate.id)) {
              project = candidate;
              break;
            }
          }
        }
        if (!project && runtime.kind === "tmux") {
          const candidate = tmuxBySession.get(runtimeSession.name);
          if (candidate && !claimedProjects.has(candidate.id)) {
            project = candidate;
          }
        }
        const existingProject = project;
        const projectName = reserveProjectName(nameOwners, space.name, existingProject);
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
        const projectChanged = !project || scalarChanged(project, projectData, ["runtimeRevision"]);
        if (project) {
          if (project.archivedAt) {
            structuralChanged = true;
          }
          if (projectChanged) {
            const updated = await prisma.project.update({
              where: { id: project.id },
              data: projectData,
            });
            project = { ...updated, tabs: project.tabs };
          }
        } else {
          const created = await prisma.project.create({ data: { ...projectData, userId } });
          project = { ...created, tabs: [] };
          structuralChanged = true;
        }
        nameOwners.set(projectName, project.id);
        byIdentity.set(key, project);
        claimedProjects.add(project.id);
        seenProjects.add(project.id);
        const seenTabs = new Set();
        const tabsByPane = new Map();
        const tabsByTmuxWindow = new Map();
        for (const existingTab of project.tabs || []) {
          if (
            existingTab.runtimePaneId &&
            (!tabsByPane.has(existingTab.runtimePaneId) ||
              (tabsByPane.get(existingTab.runtimePaneId).archivedAt && !existingTab.archivedAt))
          ) {
            tabsByPane.set(existingTab.runtimePaneId, existingTab);
          }
          if (existingTab.session?.tmuxName && !existingTab.runtimePaneId) {
            tabsByTmuxWindow.set(existingTab.session.tmuxName, existingTab);
          }
        }
        const tabPatches = [];

        for (const runtimeTab of space.tabs) {
          for (const pane of runtimeTab.panes) {
            let tab = tabsByPane.get(pane.id);
            if (!tab && runtime.kind === "tmux") {
              tab = tabsByTmuxWindow.get(runtimeTab.id);
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
            const nextSession = sessionData(
              runtime,
              runtimeSession,
              runtimeTab,
              pane,
              project.id,
              mirroredAt
            );
            if (tab) {
              if (tab.archivedAt || !tab.session || tab.session.archivedAt) {
                structuralChanged = true;
              }
              const tabChanged = scalarChanged(tab, tabData);
              const sessionChanged =
                !tab.session || scalarChanged(tab.session, nextSession, ["lastSeenAt"]);
              // Queue rather than await. A busy HerdR space can hold dozens of
              // panes and this loop ran one round trip per pane per snapshot;
              // on SQLite each was its own fsync-ing transaction. Every id is
              // already known, so the rows can be written as one batch below.
              if (tabChanged) {
                deferredWrites.push(
                  prisma.tab.update({
                    where: { id: tab.id },
                    data: {
                      ...tabData,
                      session: tab.session ? { update: nextSession } : { create: nextSession },
                    },
                  })
                );
                tab = { ...tab, ...tabData };
              } else if (sessionChanged && tab.session) {
                deferredWrites.push(
                  prisma.session.update({ where: { id: tab.session.id }, data: nextSession })
                );
                tab = { ...tab, session: { ...tab.session, ...nextSession } };
              }
              if (tabChanged || sessionChanged) {
                tabPatches.push(tabPatch(tab, tabData, pane.status));
              }
            } else {
              // Creates need the generated id for seenTabs, and only happen
              // when a pane first appears, so they stay inline.
              tab = await prisma.tab.create({
                data: {
                  ...tabData,
                  projectId: project.id,
                  session: {
                    create: nextSession,
                  },
                },
                include: { session: true },
              });
              structuralChanged = true;
            }
            tabsByPane.set(pane.id, tab);
            seenTabs.add(tab.id);
          }
        }
        if (deferredWrites.length > 0) {
          await prisma.$transaction(deferredWrites.splice(0));
        }
        // Snapshots arrive on every HerdR event and on each tmux poll, so the
        // overwhelmingly common case is "nothing moved". Two unconditional
        // updateMany calls per space per snapshot is a continuous write load
        // on SQLite that accomplishes nothing. A pane can only need archiving
        // if this project previously had a live pane the snapshot no longer
        // lists.
        const liveBefore = (project.tabs || []).filter(
          existingTab => existingTab.runtimePaneId && !existingTab.archivedAt
        );
        const archivalPossible = liveBefore.some(existingTab => !seenTabs.has(existingTab.id));
        if (archivalPossible) {
          const [archivedTabs, archivedSessions] = await prisma.$transaction([
            prisma.tab.updateMany({
              where: {
                projectId: project.id,
                runtimePaneId: { not: null },
                archivedAt: null,
                ...(seenTabs.size ? { id: { notIn: [...seenTabs] } } : {}),
              },
              data: { archivedAt: mirroredAt, status: "offline" },
            }),
            prisma.session.updateMany({
              where: {
                projectId: project.id,
                externalId: { not: null },
                archivedAt: null,
                tabId: { notIn: [...seenTabs] },
              },
              data: { archivedAt: mirroredAt, status: "offline" },
            }),
          ]);
          if (archivedTabs.count > 0 || archivedSessions.count > 0) {
            structuralChanged = true;
          }
        }
        if (projectChanged || tabPatches.length > 0) {
          patches.push({
            id: project.id,
            name: projectData.name,
            status: projectData.status,
            runtimeSpaceName: projectData.runtimeSpaceName,
            runtimeIconStyle: projectData.runtimeIconStyle,
            runtimeOrdinal: projectData.runtimeOrdinal,
            runtimeFocused: projectData.runtimeFocused,
            tabs: tabPatches,
          });
        }
      }
    }
  }

  // Same reasoning as the per-space sweep: only reach for the database when
  // a mirrored project that was live is missing from this snapshot.
  const staleProject =
    observedKinds.size > 0 &&
    existingProjects.some(
      project =>
        project.mirrored &&
        !project.archivedAt &&
        project.deviceId === deviceId &&
        observedKinds.has(project.runtime) &&
        !seenProjects.has(project.id)
    );
  if (staleProject) {
    const archivedProjects = await prisma.project.updateMany({
      where: {
        userId,
        deviceId,
        mirrored: true,
        archivedAt: null,
        runtime: { in: [...observedKinds] },
        ...(seenProjects.size ? { id: { notIn: [...seenProjects] } } : {}),
      },
      data: { archivedAt: mirroredAt, status: "offline" },
    });
    if (archivedProjects.count > 0) {
      structuralChanged = true;
    }
  }
  // Connection metadata/capabilities are persisted once by the broker after
  // this reconciliation succeeds. Keeping that write out of this helper
  // avoids two AgentToken updates for every HerdR focus/status event.
  return { snapshot, structuralChanged, patches };
}

function identityKey(deviceId, runtime, runtimeSessionId, externalId) {
  return `${deviceId}\u0000${runtime}\u0000${runtimeSessionId}\u0000${externalId}`;
}

function scalarChanged(record, data, ignored = []) {
  const skip = new Set(ignored);
  return Object.entries(data).some(([key, value]) => !skip.has(key) && record?.[key] !== value);
}

function tabPatch(tab, data, sessionStatus) {
  return {
    id: tab.id,
    ...data,
    sessionStatus,
  };
}

function sessionData(
  runtime,
  runtimeSession,
  runtimeTab,
  pane,
  projectId,
  mirroredAt = new Date()
) {
  return {
    projectId,
    kind: "agent",
    tmuxName: runtime.kind === "tmux" ? runtimeTab.id : pane.id,
    tmuxWindowName: runtimeTab.name,
    tmuxManaged: false,
    agentType: runtime.kind,
    status: pane.status,
    lastSeenAt: mirroredAt,
    runtime: runtime.kind,
    runtimeSessionId: runtimeSession.id,
    externalId: pane.id,
    terminalId: pane.terminalId,
    controllerMode: "observe",
    archivedAt: null,
  };
}

module.exports = { normalizeSnapshot, reconcileInventory };
