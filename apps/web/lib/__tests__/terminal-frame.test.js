// broker is CommonJS because it is loaded by the custom Next.js server.

const { parseAgentTerminalFrame } = require("../../server/broker");

describe("binary terminal frame", () => {
  it("preserves checkpoint boundaries, sequence, target, and raw bytes", () => {
    const streamId = Buffer.from("stream-1");
    const payload = Buffer.from([0x00, 0xff, 0x1b, 0x63]);
    const frame = Buffer.alloc(11 + streamId.length + payload.length);
    frame.write("TMG2", 0, "ascii");
    frame[4] = 0b111;
    frame.writeUInt32BE(42, 5);
    frame.writeUInt16BE(streamId.length, 9);
    streamId.copy(frame, 11);
    payload.copy(frame, 11 + streamId.length);

    expect(parseAgentTerminalFrame(frame)).toMatchObject({
      streamId: "stream-1",
      sequence: 42,
      full: true,
      checkpointContinuation: true,
      checkpointEnd: true,
      data: payload,
    });
  });

  it("rejects malformed and oversized stream identifiers", () => {
    expect(parseAgentTerminalFrame(Buffer.from("TMG2"))).toBeNull();
    const frame = Buffer.alloc(11);
    frame.write("TMG2", 0, "ascii");
    frame.writeUInt16BE(513, 9);
    expect(parseAgentTerminalFrame(frame)).toBeNull();
  });
});
