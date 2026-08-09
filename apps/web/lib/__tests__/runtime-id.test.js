const { decodeRuntimeId } = require("../../server/runtime-id");

function id(prefix, parts) {
  return `${prefix}${Buffer.from(JSON.stringify(parts)).toString("base64url")}`;
}

describe("virtual runtime ids", () => {
  test("round-trips exact local runtime identifiers without exposing them as path segments", () => {
    const value = id("rs_", ["device-1", "herdr", "session/one", "space:1", "tab 1", "p1", "t1"]);
    expect(decodeRuntimeId(value, "session")).toEqual({
      deviceId: "device-1",
      runtime: "herdr",
      runtimeSessionId: "session/one",
      spaceId: "space:1",
      tabId: "tab 1",
      paneId: "p1",
      terminalId: "t1",
    });
  });

  test("rejects the wrong identity kind and malformed payloads", () => {
    const project = id("rp_", ["device-1", "tmux", "$1", "$1", "", "", ""]);
    expect(decodeRuntimeId(project, "session")).toBeNull();
    expect(decodeRuntimeId("rs_not-base64", "session")).toBeNull();
    expect(decodeRuntimeId(id("rs_", ["d", "other", "s", "w", "", "", ""]))).toBeNull();
  });
});
