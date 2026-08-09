const MAX_RUNTIME_SESSIONS = 64;
const MAX_SPACES = 256;
const MAX_TABS = 1024;
const MAX_PANES = 2048;
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

function layout(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 64 * 1024 ? JSON.parse(serialized) : null;
  } catch {
    return null;
  }
}

/**
 * Validate and bound an untrusted agent snapshot before it reaches memory,
 * SQLite, or browsers. The normalized tree itself is now the source of truth;
 * there is deliberately no Project/Tab/Session reconciliation layer.
 */
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
            layout: layout(rawTab?.layout),
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
    roots: (Array.isArray(source.roots) ? source.roots : []).slice(0, 128).flatMap(root => {
      const key = text(root?.key, "", 120);
      const path = text(root?.path, "", 2048);
      return key && path ? [{ key, path, writable: root?.writable !== false }] : [];
    }),
    runtimes,
  };
}

module.exports = { normalizeSnapshot };
