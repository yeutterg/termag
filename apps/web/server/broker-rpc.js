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

const GIT_OPERATIONS = new Set([
  "git.status",
  "git.branch",
  "git.commit",
  "git.push",
  "git.pull",
  "git.stage",
]);

function createBrokerRpc({
  WebSocket,
  connectedAgents,
  publicAgentStatus,
  agentForUser,
  sendToAgent,
  broadcastStatus,
}) {
  return {
    connectedDevices(userId) {
      return connectedAgents(userId).map(publicAgentStatus);
    },

    async listDirectory(userId, deviceName, rootKey, relativePath) {
      requireAgent(agentForUser(userId, deviceName));
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
      requireAgent(agentForUser(userId, deviceName));
      return sendToAgent(userId, deviceName, operation, payload, timeoutMs);
    },

    async gitOperation(userId, deviceName, operation, payload = {}, timeoutMs = 35_000) {
      if (!GIT_OPERATIONS.has(operation)) {
        throw new Error("Unsupported git operation");
      }
      requireAgent(agentForUser(userId, deviceName));
      return sendToAgent(userId, deviceName, operation, payload, timeoutMs);
    },

    async acquirePowerLease(userId, deviceName, leaseId, mode, reason, durationMs, renew = false) {
      requireCapability(agentForUser(userId, deviceName), "powerPolicy");
      return sendToAgent(
        userId,
        deviceName,
        renew ? "power.renew" : "power.acquire",
        { leaseId, mode, reason, durationMs },
        5000
      );
    },

    async releasePowerLease(userId, deviceName, leaseId) {
      requireCapability(agentForUser(userId, deviceName), "powerPolicy");
      return sendToAgent(userId, deviceName, "power.release", { leaseId }, 5000);
    },

    async getCaffeinateStatus(userId, deviceName) {
      requireCapability(agentForUser(userId, deviceName), "powerPolicy");
      const result = await sendToAgent(userId, deviceName, "power.get", {}, 5000);
      return result?.state || result;
    },

    disconnectAgentToken(userId, tokenId) {
      let kicked = false;
      for (const agent of connectedAgents(userId)) {
        if (agent.tokenId === tokenId && agent.ws.readyState === WebSocket.OPEN) {
          agent.ws.close(1008, "token revoked");
          kicked = true;
        }
      }
      if (kicked) {
        broadcastStatus(userId, true);
      }
    },
  };
}

function requireAgent(agent) {
  if (!agent) {
    throw new Error("Agent offline");
  }
  return agent;
}

function requireCapability(agent, capability) {
  requireAgent(agent);
  if (!agent.capabilities?.[capability]) {
    throw new Error(`Agent does not support ${capability}`);
  }
  return agent;
}

module.exports = { createBrokerRpc };
