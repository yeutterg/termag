// inventory-v2 is intentionally CommonJS because it is loaded by the custom broker.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeSnapshot, reconcileInventory } = require("../../server/inventory-v2");

describe("protocol-v2 inventory normalization", () => {
  it("preserves HerdR identity, layout, and status vocabulary", () => {
    const snapshot = normalizeSnapshot({
      revision: 7,
      roots: [{ key: "home", path: "/Users/me", writable: true }],
      runtimes: [
        {
          kind: "herdr",
          available: true,
          sessions: [
            {
              id: "default",
              name: "default",
              spaces: [
                {
                  id: "w1",
                  name: "termag",
                  tabs: [
                    {
                      id: "w1:t1",
                      name: "agent",
                      status: "working",
                      layout: { area: { x: 0, y: 0, width: 100, height: 40 } },
                      panes: [
                        {
                          id: "w1:p1",
                          terminalId: "terminal-1",
                          name: "codex",
                          status: "done",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(snapshot.revision).toBe(7);
    expect(snapshot.runtimes[0].kind).toBe("herdr");
    expect(snapshot.runtimes[0].sessions[0].spaces[0].tabs[0].panes[0]).toMatchObject({
      id: "w1:p1",
      status: "done",
    });
  });

  it("drops unknown runtimes and normalizes untrusted statuses", () => {
    const snapshot = normalizeSnapshot({
      runtimes: [
        { kind: "other", sessions: [{ id: "ignored" }] },
        {
          kind: "tmux",
          sessions: [
            {
              id: "$1",
              spaces: [
                {
                  id: "$1",
                  tabs: [{ id: "@1", panes: [{ id: "%1", status: "injected" }] }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(snapshot.runtimes).toHaveLength(1);
    expect(snapshot.runtimes[0].sessions[0].spaces[0].tabs[0].panes[0].status).toBe("unknown");
  });

  it("does not archive mirrors when runtime discovery is unavailable", async () => {
    const prisma = {
      project: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      agentToken: { update: jest.fn().mockResolvedValue({}) },
    };
    const result = await reconcileInventory({
      prisma,
      userId: "user-1",
      deviceId: "device-1",
      deviceName: "mac",
      rawSnapshot: {
        revision: 2,
        runtimes: [{ kind: "herdr", available: false, sessions: [] }],
      },
    });

    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(result.structuralChanged).toBe(false);
  });

  it("archives missing mirrors only after a complete empty snapshot", async () => {
    const mirrored = {
      id: "project-1",
      name: "Old space",
      userId: "user-1",
      deviceId: "device-1",
      rootKey: "mac",
      runtime: "tmux",
      runtimeSessionId: "$1",
      externalId: "$1",
      mirrored: true,
      archivedAt: null,
      tabs: [],
    };
    const prisma = {
      project: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([mirrored])
          .mockResolvedValueOnce([{ id: mirrored.id, name: mirrored.name }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agentToken: { update: jest.fn().mockResolvedValue({}) },
    };
    const result = await reconcileInventory({
      prisma,
      userId: "user-1",
      deviceId: "device-1",
      deviceName: "mac",
      rawSnapshot: {
        revision: 3,
        runtimes: [{ kind: "tmux", available: true, sessions: [] }],
      },
    });

    expect(prisma.project.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ archivedAt: null }),
      })
    );
    expect(result.structuralChanged).toBe(true);
  });

  it("writes nothing when a snapshot repeats the current mirror", async () => {
    // Snapshots arrive on every HerdR event and every tmux poll. A steady
    // state used to still issue archive sweeps per space plus one per
    // project, which on SQLite is continuous write traffic for no change.
    const session = {
      id: "session-1",
      tmuxName: "@1",
      tmuxWindowName: "shell",
      tmuxManaged: false,
      kind: "agent",
      projectId: "project-1",
      tabId: "tab-1",
      agentType: "tmux",
      status: "idle",
      runtime: "tmux",
      runtimeSessionId: "$1",
      externalId: "%1",
      terminalId: "%1",
      controllerMode: "observe",
      archivedAt: null,
      lastSeenAt: new Date(0),
    };
    const tab = {
      id: "tab-1",
      name: "shell",
      ordinal: 0,
      status: "idle",
      externalId: "@1",
      runtimeTabId: "@1",
      runtimeTabName: "shell",
      runtimeTabStatus: "idle",
      runtimePaneId: "%1",
      runtimePaneName: "shell",
      runtimePaneIndex: 0,
      layout: null,
      focused: true,
      archivedAt: null,
      session,
    };
    const project = {
      id: "project-1",
      name: "tmux-space",
      userId: "user-1",
      deviceId: "device-1",
      rootKey: "mac",
      relativePath: "tmux/main",
      tmuxSessionName: "$1",
      tmuxManaged: false,
      agentType: "tmux",
      agentSpawnCommand: "$SHELL",
      status: "idle",
      runtime: "tmux",
      runtimeSessionId: "$1",
      runtimeSessionName: "main",
      runtimeSpaceName: "tmux-space",
      runtimeIconStyle: null,
      runtimeOrdinal: 0,
      runtimeFocused: true,
      externalId: "$1",
      runtimeRevision: 4,
      creationPath: "/Users/x",
      mirrored: true,
      archivedAt: null,
      tabs: [tab],
    };
    const prisma = {
      project: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([project])
          .mockResolvedValueOnce([{ id: project.id, name: project.name }]),
        update: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      tab: { update: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
      session: { update: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
      agentToken: { update: jest.fn().mockResolvedValue({}) },
    };

    const result = await reconcileInventory({
      prisma,
      userId: "user-1",
      deviceId: "device-1",
      deviceName: "mac",
      rawSnapshot: {
        revision: 5,
        runtimes: [
          {
            kind: "tmux",
            available: true,
            sessions: [
              {
                id: "$1",
                name: "main",
                path: "/Users/x",
                status: "idle",
                spaces: [
                  {
                    id: "$1",
                    name: "tmux-space",
                    ordinal: 0,
                    status: "idle",
                    focused: true,
                    activeTabId: "@1",
                    tabs: [
                      {
                        id: "@1",
                        name: "shell",
                        ordinal: 0,
                        status: "idle",
                        focused: true,
                        panes: [
                          {
                            id: "%1",
                            terminalId: "%1",
                            name: "shell",
                            ordinal: 0,
                            status: "idle",
                            focused: true,
                            cwd: "/Users/x",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(prisma.tab.update).not.toHaveBeenCalled();
    expect(prisma.tab.create).not.toHaveBeenCalled();
    expect(prisma.tab.updateMany).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.structuralChanged).toBe(false);
    expect(result.patches).toHaveLength(0);
  });
});
