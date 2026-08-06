const { runtimeProjectId, runtimeTabId } = require("./runtime-id");

const VOLATILE_KEYS = new Set(["revision", "status", "focused", "activeTabId"]);

/**
 * Return a compact browser patch when only live status/focus values changed.
 * A null result means the inventory's structure changed and callers must
 * refresh the full project tree instead.
 */
function createInventoryPatch(previous, next, deviceId) {
  if (!previous || !next || !sameStructure(previous, next)) {
    return null;
  }
  const projects = [];
  for (let runtimeIndex = 0; runtimeIndex < next.runtimes.length; runtimeIndex += 1) {
    const runtime = next.runtimes[runtimeIndex];
    const oldRuntime = previous.runtimes[runtimeIndex];
    if (!runtime.available) {
      continue;
    }
    for (let sessionIndex = 0; sessionIndex < runtime.sessions.length; sessionIndex += 1) {
      const session = runtime.sessions[sessionIndex];
      const oldSession = oldRuntime.sessions[sessionIndex];
      for (let spaceIndex = 0; spaceIndex < session.spaces.length; spaceIndex += 1) {
        const space = session.spaces[spaceIndex];
        const oldSpace = oldSession.spaces[spaceIndex];
        const identity = {
          deviceId,
          runtime: runtime.kind,
          runtimeSessionId: session.id,
          spaceId: space.id,
        };
        const project = { id: runtimeProjectId(identity) };
        let changed = false;
        if (space.status !== oldSpace.status) {
          project.status = space.status;
          changed = true;
        }
        if (space.focused !== oldSpace.focused) {
          project.runtimeFocused = space.focused;
          changed = true;
        }
        const tabs = [];
        for (let tabIndex = 0; tabIndex < space.tabs.length; tabIndex += 1) {
          const tab = space.tabs[tabIndex];
          const oldTab = oldSpace.tabs[tabIndex];
          for (let paneIndex = 0; paneIndex < tab.panes.length; paneIndex += 1) {
            const pane = tab.panes[paneIndex];
            const oldPane = oldTab.panes[paneIndex];
            const focused = paneFocused(space, tab, pane);
            const oldFocused = paneFocused(oldSpace, oldTab, oldPane);
            if (
              pane.status === oldPane.status &&
              tab.status === oldTab.status &&
              focused === oldFocused
            ) {
              continue;
            }
            tabs.push({
              id: runtimeTabId({
                ...identity,
                tabId: tab.id,
                paneId: pane.id,
                terminalId: pane.terminalId || pane.id,
              }),
              ...(pane.status !== oldPane.status ? { status: pane.status } : {}),
              ...(tab.status !== oldTab.status ? { runtimeTabStatus: tab.status } : {}),
              ...(focused !== oldFocused ? { focused } : {}),
            });
          }
        }
        if (tabs.length) {
          project.tabs = tabs;
          changed = true;
        }
        if (changed) {
          projects.push(project);
        }
      }
    }
  }
  return { type: "inventory-patch", revision: next.revision, projects };
}

function paneFocused(space, tab, pane) {
  return Boolean(
    pane.focused || (tab.id === space.activeTabId && pane.ordinal === tab.panes[0]?.ordinal)
  );
}

function sameStructure(left, right, key = "", insideLayout = false) {
  if (!insideLayout && VOLATILE_KEYS.has(key)) {
    return true;
  }
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameStructure(value, right[index], "", insideLayout));
  }
  if (typeof left !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left).filter(
    candidate => insideLayout || !VOLATILE_KEYS.has(candidate)
  );
  const rightKeys = Object.keys(right).filter(
    candidate => insideLayout || !VOLATILE_KEYS.has(candidate)
  );
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    candidate =>
      Object.prototype.hasOwnProperty.call(right, candidate) &&
      sameStructure(
        left[candidate],
        right[candidate],
        candidate,
        insideLayout || candidate === "layout"
      )
  );
}

module.exports = { createInventoryPatch, sameStructure };
