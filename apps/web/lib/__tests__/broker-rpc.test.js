const { createBrokerRpc } = require("../../server/broker-rpc");

function makeRpc(overrides = {}) {
  const sendToAgent = jest.fn(async (_userId, _deviceName, operation) => {
    if (operation === "tmux-list") {
      return { sessions: [{ name: "local", windowCount: 1 }] };
    }
    return { ok: true };
  });
  const agent = {
    deviceName: "laptop",
    protocolVersion: 2,
    capabilities: { powerPolicy: true },
    ws: { readyState: 1, close: jest.fn() },
  };
  const options = {
    WebSocket: { OPEN: 1 },
    agentsForUser: () => new Map([[agent.deviceName, agent]]),
    connectedAgents: () => [agent],
    publicAgentStatus: value => ({ name: value.deviceName, connected: true }),
    agentForUser: () => agent,
    sendJson: jest.fn(),
    sendToAgent,
    broadcastStatus: jest.fn(),
    sshLifecycle: {
      hasUser: () => true,
      statuses: () => [],
      snapshots: () => [{ rootKey: "remote", sessions: [{ name: "remote-tmux", windowCount: 2 }] }],
      refresh: jest.fn(async () => {}),
      probe: jest.fn(async () => ({})),
      forget: jest.fn(),
    },
    ...overrides,
  };
  return { rpc: createBrokerRpc(options), sendToAgent, agent, options };
}

describe("broker RPC facade", () => {
  test("allows only typed runtime mutations", async () => {
    const { rpc, sendToAgent } = makeRpc();

    await expect(
      rpc.mutateRuntime("u1", "laptop", "runtime.create-tab", { name: "shell" })
    ).resolves.toEqual({ ok: true });
    await expect(rpc.mutateRuntime("u1", "laptop", "execute-command", {})).rejects.toThrow(
      "Unsupported runtime operation"
    );
    expect(sendToAgent).toHaveBeenCalledTimes(1);
  });

  test("allows only typed git operations", async () => {
    const { rpc, sendToAgent } = makeRpc();

    await expect(
      rpc.gitOperation("u1", "laptop", "git.status", { rootKey: "laptop" })
    ).resolves.toEqual({ ok: true });
    await expect(rpc.gitOperation("u1", "laptop", "git.shell", {})).rejects.toThrow(
      "Unsupported git operation"
    );
    expect(sendToAgent).toHaveBeenCalledTimes(1);
  });

  test("merges local-agent and SSH tmux inventories", async () => {
    const { rpc } = makeRpc();

    await expect(rpc.listTmuxSessions("u1")).resolves.toEqual([
      { name: "local", windowCount: 1, rootKey: "laptop" },
      { name: "remote-tmux", windowCount: 2, rootKey: "remote" },
    ]);
  });

  test("rejects power leases when the connected agent lacks the capability", async () => {
    const { rpc } = makeRpc({
      agentForUser: () => ({ protocolVersion: 2, capabilities: {} }),
    });

    await expect(
      rpc.acquirePowerLease("u1", "laptop", "lease-1", "terminals-awake", "test", 60_000)
    ).rejects.toThrow("does not support renewable power leases");
  });
});
