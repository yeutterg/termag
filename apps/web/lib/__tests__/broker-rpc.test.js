const { createBrokerRpc } = require("../../server/broker-rpc");

function makeRpc(overrides = {}) {
  const sendToAgent = jest.fn(async () => ({ ok: true }));
  const agent = {
    deviceName: "laptop",
    tokenId: "token-1",
    protocolVersion: 2,
    capabilities: { powerPolicy: true, gitOperations: true },
    ws: { readyState: 1, close: jest.fn() },
  };
  const options = {
    WebSocket: { OPEN: 1 },
    connectedAgents: () => [agent],
    publicAgentStatus: value => ({ name: value.deviceName, connected: true }),
    agentForUser: () => agent,
    sendToAgent,
    broadcastStatus: jest.fn(),
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
      rpc.gitOperation("u1", "laptop", "git.status", { rootKey: "work" })
    ).resolves.toEqual({ ok: true });
    await expect(rpc.gitOperation("u1", "laptop", "git.shell", {})).rejects.toThrow(
      "Unsupported git operation"
    );
    expect(sendToAgent).toHaveBeenCalledTimes(1);
  });

  test("routes directory listing through the named connected agent", async () => {
    const { rpc, sendToAgent } = makeRpc();
    await rpc.listDirectory("u1", "laptop", "work", "termag");
    expect(sendToAgent).toHaveBeenCalledWith(
      "u1",
      "laptop",
      "list-directory",
      { rootKey: "work", relativePath: "termag" },
      5000
    );
  });

  test("returns every connected machine for one web user", () => {
    const laptop = {
      deviceName: "laptop",
      ws: { readyState: 1 },
    };
    const workstation = {
      deviceName: "workstation",
      ws: { readyState: 1 },
    };
    const { rpc } = makeRpc({
      connectedAgents: () => [laptop, workstation],
      publicAgentStatus: agent => ({ name: agent.deviceName, connected: true }),
    });

    expect(rpc.connectedDevices("u1")).toEqual([
      { name: "laptop", connected: true },
      { name: "workstation", connected: true },
    ]);
  });

  test("rejects power leases without the declared capability", async () => {
    const { rpc } = makeRpc({ agentForUser: () => ({ capabilities: {} }) });
    await expect(
      rpc.acquirePowerLease("u1", "laptop", "lease-1", "terminals-awake", "test", 60_000)
    ).rejects.toThrow("Agent does not support powerPolicy");
  });

  test("revocation closes only the matching live token", () => {
    const { rpc, agent, options } = makeRpc();
    rpc.disconnectAgentToken("u1", "token-1");
    expect(agent.ws.close).toHaveBeenCalledWith(1008, "token revoked");
    expect(options.broadcastStatus).toHaveBeenCalledWith("u1", true);
  });
});
