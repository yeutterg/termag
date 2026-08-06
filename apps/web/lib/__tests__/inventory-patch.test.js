const { createInventoryPatch, sameStructure } = require("../../server/inventory-patch");
const { normalizeSnapshot } = require("../../server/inventory-v2");
const { decodeRuntimeId } = require("../../server/runtime-id");

function snapshot(overrides = {}) {
  return normalizeSnapshot({
    revision: overrides.revision ?? 1,
    roots: [{ key: "projects", path: "/Users/me/Projects", writable: true }],
    runtimes: [
      {
        kind: "herdr",
        available: true,
        sessions: [
          {
            id: "personal",
            name: "Personal",
            path: "/Users/me/Projects/terminalz",
            statusIndicators: "symbols",
            status: overrides.sessionStatus ?? "working",
            spaces: [
              {
                id: "space-1",
                name: overrides.spaceName ?? "terminalz",
                ordinal: 0,
                status: overrides.spaceStatus ?? "working",
                focused: overrides.spaceFocused ?? true,
                activeTabId: Object.prototype.hasOwnProperty.call(overrides, "activeTabId")
                  ? overrides.activeTabId
                  : "tab-1",
                tabs: [
                  {
                    id: "tab-1",
                    name: "Agent",
                    ordinal: 0,
                    status: overrides.tabStatus ?? "working",
                    focused: true,
                    layout: overrides.layout ?? { area: { status: "layout-value", width: 120 } },
                    panes: [
                      {
                        id: "pane-1",
                        terminalId: "terminal-1",
                        name: "Codex",
                        ordinal: 0,
                        status: overrides.paneStatus ?? "working",
                        focused: overrides.paneFocused ?? false,
                        cwd: "/Users/me/Projects/terminalz",
                        command: "codex",
                        agent: "codex",
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
}

describe("compact inventory patches", () => {
  it("encodes status and focus changes with the same stable project/tab ids", () => {
    const before = snapshot();
    const after = snapshot({
      revision: 2,
      sessionStatus: "idle",
      spaceStatus: "idle",
      spaceFocused: false,
      tabStatus: "done",
      paneStatus: "idle",
      activeTabId: null,
    });

    const patch = createInventoryPatch(before, after, "device-1");
    expect(patch).not.toBeNull();
    expect(patch.projects).toHaveLength(1);
    expect(patch.projects[0]).toMatchObject({
      status: "idle",
      runtimeFocused: false,
      tabs: [{ status: "idle", runtimeTabStatus: "done", focused: false }],
    });
    expect(decodeRuntimeId(patch.projects[0].id, "project")).toMatchObject({
      deviceId: "device-1",
      runtimeSessionId: "personal",
      spaceId: "space-1",
    });
    expect(decodeRuntimeId(patch.projects[0].tabs[0].id, "tab")).toMatchObject({
      tabId: "tab-1",
      paneId: "pane-1",
      terminalId: "terminal-1",
    });
    expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(after).length / 2);
  });

  it("requires a full refresh for names, layout, or other structural changes", () => {
    const before = snapshot();
    expect(
      createInventoryPatch(before, snapshot({ revision: 2, spaceName: "renamed" }), "d")
    ).toBeNull();
    expect(
      createInventoryPatch(
        before,
        snapshot({ revision: 2, layout: { area: { status: "changed", width: 120 } } }),
        "d"
      )
    ).toBeNull();
  });

  it("treats a revision-only update as an empty live patch", () => {
    const before = snapshot();
    const after = snapshot({ revision: 2 });
    expect(sameStructure(before, after)).toBe(true);
    expect(createInventoryPatch(before, after, "device-1")).toEqual({
      type: "inventory-patch",
      revision: 2,
      projects: [],
    });
  });
});
