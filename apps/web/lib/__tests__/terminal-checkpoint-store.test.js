const { createTerminalCheckpointStore } = require("../../server/terminal-checkpoint-store");

function frame(sequence, data, flags = {}) {
  return {
    sequence,
    data: Buffer.from(data),
    full: false,
    checkpointContinuation: false,
    checkpointEnd: false,
    ...flags,
  };
}

describe("terminal checkpoint store", () => {
  it("replays an exact full checkpoint followed by ordered tail frames", () => {
    const store = createTerminalCheckpointStore();
    store.ingest("s1", frame(1, "screen", { full: true, checkpointEnd: true }));
    store.ingest("s1", frame(2, "-tail-a"));
    store.ingest("s1", frame(3, "-tail-b"));

    expect(Buffer.concat(store.replay("s1").chunks).toString()).toBe("screen-tail-a-tail-b");
  });

  it("drops a checkpoint on a sequence gap", () => {
    const store = createTerminalCheckpointStore();
    store.ingest("s1", frame(4, "screen", { full: true, checkpointEnd: true }));

    expect(store.ingest("s1", frame(6, "missed-five"))).toEqual({ gap: true });
    expect(store.replay("s1")).toBeNull();
  });

  it("drops continuation-without-start but lets the caller fan it out", () => {
    const store = createTerminalCheckpointStore();
    const result = store.ingest(
      "s1",
      frame(1, "continued", { checkpointContinuation: true, checkpointEnd: true })
    );

    expect(result.gap).toBe(false);
    expect(store.replay("s1")).toBeNull();
  });

  it("returns byte accounting to zero when a session drops", () => {
    const store = createTerminalCheckpointStore();
    store.ingest("s1", frame(1, "screen", { full: true, checkpointEnd: true }));
    store.ingest("s1", frame(2, "tail"));
    expect(store.stats().bytes).toBe(10);

    store.drop("s1");
    expect(store.stats()).toMatchObject({ bytes: 0, checkpoints: 0, sequences: 0 });
  });

  it("enforces full and tail byte caps without retaining partial state", () => {
    const store = createTerminalCheckpointStore({ maxFullBytes: 8, maxTailBytes: 4 });
    store.ingest("full", frame(1, "123456", { full: true }));
    store.ingest("full", frame(2, "789", { checkpointContinuation: true, checkpointEnd: true }));
    expect(store.replay("full")).toBeNull();

    store.ingest("tail", frame(1, "base", { full: true, checkpointEnd: true }));
    store.ingest("tail", frame(2, "12345"));
    expect(store.replay("tail")).toBeNull();
    expect(store.stats().bytes).toBe(0);
  });

  it("allows the first checkpoint request even when the injected clock starts at zero", () => {
    let now = 0;
    const store = createTerminalCheckpointStore({ now: () => now });

    expect(store.claimCheckpointRequest("s1")).toBe(true);
    expect(store.claimCheckpointRequest("s1")).toBe(false);
    now = 5001;
    expect(store.claimCheckpointRequest("s1")).toBe(true);
  });
});
