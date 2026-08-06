const { normalizeSnapshot } = require("../../server/inventory-v2");

describe("protocol-v2 inventory normalization", () => {
  it("preserves bounded Herdr identity, layout, order, and status", () => {
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
              statusIndicators: "symbols",
              spaces: [
                {
                  id: "w1",
                  name: "termag",
                  ordinal: 3,
                  tabs: [
                    {
                      id: "w1:t1",
                      name: "agent",
                      status: "working",
                      layout: { area: { x: 0, y: 0, width: 100, height: 40 }, panes: [] },
                      panes: [
                        { id: "w1:p1", terminalId: "terminal-1", name: "codex", status: "done" },
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

    const session = snapshot.runtimes[0].sessions[0];
    expect(snapshot.revision).toBe(7);
    expect(session.statusIndicators).toBe("symbols");
    expect(session.spaces[0]).toMatchObject({ id: "w1", name: "termag", ordinal: 3 });
    expect(session.spaces[0].tabs[0].panes[0]).toMatchObject({
      id: "w1:p1",
      terminalId: "terminal-1",
      status: "done",
    });
  });

  it("drops unknown runtimes, control characters, and untrusted statuses", () => {
    const snapshot = normalizeSnapshot({
      runtimes: [
        { kind: "other", sessions: [{ id: "ignored" }] },
        {
          kind: "tmux",
          sessions: [
            {
              id: "$1\u0000",
              spaces: [
                { id: "$1", tabs: [{ id: "@1", panes: [{ id: "%1", status: "injected" }] }] },
              ],
            },
          ],
        },
      ],
    });

    expect(snapshot.runtimes).toHaveLength(1);
    expect(snapshot.runtimes[0].sessions[0].id).toBe("$1");
    expect(snapshot.runtimes[0].sessions[0].spaces[0].tabs[0].panes[0].status).toBe("unknown");
  });

  it("drops oversized layout payloads", () => {
    const snapshot = normalizeSnapshot({
      runtimes: [
        {
          kind: "herdr",
          sessions: [
            {
              id: "s",
              spaces: [
                {
                  id: "w",
                  tabs: [{ id: "t", layout: { value: "x".repeat(300_000) }, panes: [] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(snapshot.runtimes[0].sessions[0].spaces[0].tabs[0].layout).toBeNull();
  });

  it("rejects snapshots over the session limit", () => {
    expect(() =>
      normalizeSnapshot({
        runtimes: [
          {
            kind: "tmux",
            sessions: Array.from({ length: 129 }, (_, index) => ({ id: `$${index}` })),
          },
        ],
      })
    ).toThrow("inventory session limit exceeded");
  });
});
