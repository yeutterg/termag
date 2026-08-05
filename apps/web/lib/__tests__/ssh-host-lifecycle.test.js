const { createSshHostLifecycle } = require("../../server/ssh-host-lifecycle");

function makePrisma(rowsRef) {
  return {
    sshHost: {
      findMany: jest.fn(async () => rowsRef.current),
      update: jest.fn(async () => ({})),
    },
    shareLink: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    auditEvent: { create: jest.fn(async () => ({})) },
  };
}

function host(overrides = {}) {
  return {
    id: "host-1",
    name: "build-box",
    host: "build.example.test",
    port: 22,
    user: "greg",
    lastSeenAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("SSH host lifecycle", () => {
  test("remembers an empty inventory so callers do not reload it on every read", async () => {
    const rows = { current: [] };
    const lifecycle = createSshHostLifecycle({
      prisma: makePrisma(rows),
      broadcastStatus: jest.fn(),
      sendJson: jest.fn(),
      sanitizeText: String,
      pollIntervalMs: 0,
      streamRegistry: { forgetHost: jest.fn(), getOrCreate: jest.fn() },
      sshHelpers: {},
    });

    expect(lifecycle.hasUser("user-1")).toBe(false);
    await lifecycle.refresh("user-1", { broadcast: false });
    expect(lifecycle.hasUser("user-1")).toBe(true);
    expect(lifecycle.statuses("user-1")).toEqual([]);
    lifecycle.close();
  });

  test("coalesces probes, publishes changed sessions, and tears streams down on removal", async () => {
    const rows = { current: [host()] };
    const prisma = makePrisma(rows);
    const broadcastStatus = jest.fn();
    const forgetHost = jest.fn();
    let releaseProbe;
    const probeResult = new Promise(resolve => {
      releaseProbe = resolve;
    });
    const probeSshHost = jest.fn(() => probeResult);
    const listSshTmuxSessions = jest.fn(async () => [
      { name: "editor", path: "/srv/app", windowCount: 2 },
    ]);
    const lifecycle = createSshHostLifecycle({
      prisma,
      broadcastStatus,
      sendJson: jest.fn(),
      sanitizeText: String,
      pollIntervalMs: 0,
      streamRegistry: { forgetHost, getOrCreate: jest.fn() },
      sshHelpers: { probeSshHost, listSshTmuxSessions },
    });

    await lifecycle.refresh("user-1", { broadcast: false });
    const concurrent = lifecycle.probe("user-1", "host-1");
    expect(probeSshHost).toHaveBeenCalledTimes(1);
    releaseProbe({ ok: true });
    await concurrent;

    expect(lifecycle.statuses("user-1")[0]).toMatchObject({
      name: "build-box",
      connected: true,
      tmuxSessions: [{ name: "editor", path: "/srv/app", windowCount: 2 }],
    });
    expect(listSshTmuxSessions).toHaveBeenCalledTimes(1);
    expect(broadcastStatus).toHaveBeenCalledWith("user-1", true);

    rows.current = [];
    await lifecycle.refresh("user-1", { broadcast: false });
    expect(forgetHost).toHaveBeenCalledWith("user-1", "host-1");
    expect(lifecycle.statuses("user-1")).toEqual([]);
    lifecycle.close();
  });
});
