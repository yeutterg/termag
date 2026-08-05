const SHELL_COMMAND_RE = /^(zsh|bash|sh|fish|ksh|dash|-zsh|-bash)$/;

function addTarget(targets, value) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    targets.add(trimmed);
  }
}

function scopedTarget(sessionName, target) {
  return `${sessionName}\u0000${target}`;
}

function normalizeSessions(input) {
  return (Array.isArray(input) ? input : [])
    .map(session => ({
      name: typeof session?.name === "string" ? session.name : "",
      path: typeof session?.path === "string" ? session.path : undefined,
      windowCount: Number.isFinite(Number(session?.windowCount))
        ? Number(session.windowCount)
        : undefined,
      windows: (Array.isArray(session?.windows) ? session.windows : [])
        .map(window => ({
          index: Number.isFinite(Number(window?.index)) ? Number(window.index) : 0,
          id: typeof window?.id === "string" ? window.id : "",
          name: typeof window?.name === "string" ? window.name : "",
          target: typeof window?.target === "string" ? window.target : "",
          path: typeof window?.path === "string" ? window.path : undefined,
          activityAgeSec: Number.isFinite(Number(window?.activityAgeSec))
            ? Number(window.activityAgeSec)
            : undefined,
          bell: typeof window?.bell === "boolean" ? window.bell : undefined,
          currentCommand:
            typeof window?.currentCommand === "string" ? window.currentCommand : undefined,
          lastExit: Number.isFinite(Number(window?.lastExit)) ? Number(window.lastExit) : undefined,
        }))
        .filter(window => window.target || window.id || window.name),
    }))
    .filter(session => session.name);
}

function buildLiveState(tmuxSessions) {
  const state = {
    sessions: new Set(),
    windows: new Set(),
    globalWindows: new Set(),
    facts: new Map(),
  };
  for (const session of Array.isArray(tmuxSessions) ? tmuxSessions : []) {
    const sessionName = typeof session?.name === "string" ? session.name.trim() : "";
    if (!sessionName) {
      continue;
    }
    state.sessions.add(sessionName);
    for (const window of Array.isArray(session.windows) ? session.windows : []) {
      const targets = new Set();
      addTarget(targets, window?.target);
      addTarget(targets, window?.id);
      addTarget(targets, window?.name);
      const facts = {
        activityAgeSec: window?.activityAgeSec,
        bell: window?.bell,
        currentCommand: window?.currentCommand,
        lastExit: window?.lastExit,
      };
      for (const target of targets) {
        state.globalWindows.add(target);
        state.windows.add(scopedTarget(sessionName, target));
        state.facts.set(target, facts);
        state.facts.set(scopedTarget(sessionName, target), facts);
      }
    }
  }
  return state;
}

function targetCandidates(session, projectSessionName) {
  const candidates = new Set();
  addTarget(candidates, session.tmuxName);
  addTarget(candidates, session.tmuxWindowName);
  if (projectSessionName && typeof session.tmuxName === "string") {
    const prefix = `${projectSessionName}:`;
    if (session.tmuxName.startsWith(prefix)) {
      addTarget(candidates, session.tmuxName.slice(prefix.length));
    }
  }
  return candidates;
}

function projectSessionName(session) {
  return typeof session.project?.tmuxSessionName === "string"
    ? session.project.tmuxSessionName.trim()
    : "";
}

function isLive(session, state) {
  const projectName = projectSessionName(session);
  const tmuxName = typeof session.tmuxName === "string" ? session.tmuxName.trim() : "";
  if (projectName) {
    if (tmuxName === projectName && state.sessions.has(projectName)) {
      return true;
    }
    for (const candidate of targetCandidates(session, projectName)) {
      if (state.windows.has(scopedTarget(projectName, candidate))) {
        return true;
      }
    }
    return false;
  }
  if (state.sessions.has(tmuxName)) {
    return true;
  }
  for (const candidate of targetCandidates(session, "")) {
    if (state.globalWindows.has(candidate)) {
      return true;
    }
  }
  return false;
}

function factsFor(session, state) {
  const projectName = projectSessionName(session);
  if (projectName) {
    for (const candidate of targetCandidates(session, projectName)) {
      const facts = state.facts.get(scopedTarget(projectName, candidate));
      if (facts) {
        return facts;
      }
    }
    return null;
  }
  for (const candidate of targetCandidates(session, "")) {
    const facts = state.facts.get(candidate);
    if (facts) {
      return facts;
    }
  }
  return null;
}

function createTmuxStatusClassifier(options = {}) {
  const ptyStatuses = options.ptyStatuses ?? new Map();
  const hasAttachedViewer = options.hasAttachedViewer ?? (() => false);
  const now = options.now ?? Date.now;
  const workingThresholdSec = options.workingThresholdSec ?? 8;
  const ptyFreshMs = options.ptyFreshMs ?? 5000;

  function classify(session, facts) {
    const pty = ptyStatuses.get(session.id);
    if (pty && now() - pty.at < ptyFreshMs && hasAttachedViewer(session.id)) {
      return pty.status;
    }
    if (facts) {
      if (typeof facts.activityAgeSec === "number" && facts.activityAgeSec < workingThresholdSec) {
        return "working";
      }
      if (facts.bell === true) {
        return "waiting";
      }
      if (typeof facts.lastExit === "number" && facts.lastExit !== 0) {
        return "error";
      }
      if (typeof facts.currentCommand === "string" && SHELL_COMMAND_RE.test(facts.currentCommand)) {
        return "idle";
      }
      return "waiting";
    }
    return session.status && session.status !== "sleeping" ? session.status : "idle";
  }

  return { normalizeSessions, buildLiveState, isLive, factsFor, classify };
}

module.exports = { createTmuxStatusClassifier };
