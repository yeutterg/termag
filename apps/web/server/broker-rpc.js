const RUNTIME_OPERATIONS = new Set([
  "runtime.create-session",
  "runtime.create-space",
  "runtime.create-tab",
  "runtime.rename-space",
  "runtime.rename-tab",
  "runtime.rename-pane",
  "runtime.close-tab",
  "runtime.close-pane",
  "runtime.close-space",
  "runtime.close-session",
]);

function createBrokerRpc({
  WebSocket,
  agentsForUser,
  connectedAgents,
  publicAgentStatus,
  agentForUser,
  sendJson,
  sendToAgent,
  broadcastStatus,
  sshLifecycle,
}) {
  return {
    refreshUser(userId) {
      broadcastStatus(userId, true);
    },

    connectedDevices(userId) {
      if (!sshLifecycle.hasUser(userId)) {
        sshLifecycle.refresh(userId).catch(() => {});
      }
      return [...connectedAgents(userId).map(publicAgentStatus), ...sshLifecycle.statuses(userId)];
    },

    refreshSshHosts: sshLifecycle.refresh,
    probeSshHost: sshLifecycle.probe,
    forgetSshHost: sshLifecycle.forget,

    requestHealthRefresh(userId, deviceName) {
      const agent = agentForUser(userId, deviceName);
      if (agent) {
        sendJson(agent.ws, { type: "health-request" });
      }
    },

    async listTmuxSessions(userId) {
      const agentResults = await Promise.all(
        connectedAgents(userId).map(async agent => {
          try {
            const data = await sendToAgent(userId, agent.deviceName, "tmux-list", {}, 5000);
            const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
            return sessions.map(session => ({ ...session, rootKey: agent.deviceName }));
          } catch {
            return [];
          }
        })
      );
      const sshResults = sshLifecycle
        .snapshots(userId)
        .flatMap(snapshot =>
          snapshot.sessions.map(session => ({ ...session, rootKey: snapshot.rootKey }))
        );
      return [...agentResults.flat(), ...sshResults];
    },

    async listDirectory(userId, deviceName, rootKey, relativePath) {
      if (!agentForUser(userId, deviceName)) {
        throw new Error("Agent offline");
      }
      return sendToAgent(
        userId,
        deviceName,
        "list-directory",
        { rootKey, relativePath: relativePath || "" },
        5000
      );
    },

    async mutateRuntime(userId, deviceName, operation, payload = {}, timeoutMs = 10_000) {
      if (!RUNTIME_OPERATIONS.has(operation)) {
        throw new Error("Unsupported runtime operation");
      }
      if (!agentForUser(userId, deviceName)) {
        throw new Error("Agent offline");
      }
      return sendToAgent(userId, deviceName, operation, payload, timeoutMs);
    },

    async startCaffeinate(userId, deviceName, mode, reason, durationMs) {
      const agent = agentForUser(userId, deviceName);
      if (!agent) {
        throw new Error("Agent offline");
      }
      const wireMode =
        agent.protocolVersion >= 2
          ? mode
          : mode === "terminals-awake"
            ? "while-task"
            : mode === "display-awake"
              ? "forever"
              : mode === "ac-awake"
                ? "while-task"
                : mode;
      return sendToAgent(
        userId,
        deviceName,
        "caffeinate-start",
        { mode: wireMode, reason, durationMs },
        5000
      );
    },

    async stopCaffeinate(userId, deviceName) {
      requireAgent(agentForUser(userId, deviceName));
      return sendToAgent(userId, deviceName, "caffeinate-stop", {}, 5000);
    },

    async acquirePowerLease(userId, deviceName, leaseId, mode, reason, durationMs, renew = false) {
      requirePowerAgent(agentForUser(userId, deviceName));
      return sendToAgent(
        userId,
        deviceName,
        renew ? "power.renew" : "power.acquire",
        { leaseId, mode, reason, durationMs },
        5000
      );
    },

    async releasePowerLease(userId, deviceName, leaseId) {
      requirePowerAgent(agentForUser(userId, deviceName));
      return sendToAgent(userId, deviceName, "power.release", { leaseId }, 5000);
    },

    async getCaffeinateStatus(userId, deviceName) {
      requireAgent(agentForUser(userId, deviceName));
      const result = await sendToAgent(userId, deviceName, "caffeinate-status", {}, 5000);
      return result?.state || result;
    },

    killTmuxSession(userId, deviceName, tmuxSessionName, timeoutMs = 5000) {
      if (!tmuxSessionName || !agentForUser(userId, deviceName)) {
        return Promise.resolve(false);
      }
      return sendToAgent(userId, deviceName, "tmux-kill-session", { tmuxSessionName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },

    killTmuxWindow(userId, deviceName, tmuxName, timeoutMs = 5000) {
      if (!tmuxName || !agentForUser(userId, deviceName)) {
        return Promise.resolve(false);
      }
      return sendToAgent(userId, deviceName, "tmux-kill-window", { tmuxName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },

    renameTmuxWindow(userId, deviceName, tmuxName, name, timeoutMs = 5000) {
      if (!tmuxName || !name || !agentForUser(userId, deviceName)) {
        return Promise.resolve(null);
      }
      return sendToAgent(
        userId,
        deviceName,
        "tmux-rename-window",
        { tmuxName, name },
        timeoutMs
      ).catch(() => null);
    },

    disconnectAgentToken(userId, tokenId) {
      let kicked = false;
      for (const agent of agentsForUser(userId).values()) {
        if (agent.tokenId === tokenId && agent.ws.readyState === WebSocket.OPEN) {
          agent.ws.close(1008, "token revoked");
          kicked = true;
        }
      }
      if (kicked) {
        broadcastStatus(userId, true);
      }
    },

    killTmux(userId, tmuxName, timeoutMs = 5000) {
      if (!tmuxName || !agentForUser(userId)) {
        return Promise.resolve(false);
      }
      return sendToAgent(userId, undefined, "tmux-kill", { tmuxName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },
  };
}

function requireAgent(agent) {
  if (!agent) {
    throw new Error("Agent offline");
  }
  return agent;
}

function requirePowerAgent(agent) {
  requireAgent(agent);
  if (agent.protocolVersion < 2 || !agent.capabilities?.powerPolicy) {
    throw new Error("Agent does not support renewable power leases");
  }
  return agent;
}

module.exports = { createBrokerRpc };
