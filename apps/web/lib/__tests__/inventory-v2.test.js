// inventory-v2 is intentionally CommonJS because it is loaded by the custom broker.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeSnapshot } = require("../../server/inventory-v2");

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
});
