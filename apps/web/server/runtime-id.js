const PREFIX = { project: "rp_", tab: "rt_", session: "rs_" };

function encode(kind, identity) {
  const payload = [
    identity.deviceId,
    identity.runtime,
    identity.runtimeSessionId,
    identity.spaceId,
    identity.tabId || "",
    identity.paneId || "",
    identity.terminalId || "",
  ];
  return `${PREFIX[kind]}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function runtimeProjectId(identity) {
  return encode("project", identity);
}

function runtimeTabId(identity) {
  return encode("tab", identity);
}

function runtimeSessionId(identity) {
  return encode("session", identity);
}

function decodeRuntimeId(value, expected) {
  if (typeof value !== "string" || value.length > 4096) {
    return null;
  }
  const kind = Object.keys(PREFIX).find(key => value.startsWith(PREFIX[key]));
  if (!kind || (expected && kind !== expected)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(PREFIX[kind].length), "base64url").toString()
    );
    if (!Array.isArray(parsed) || parsed.length !== 7) {
      return null;
    }
    const [deviceId, runtime, runtimeSessionId, spaceId, tabId, paneId, terminalId] = parsed;
    if (
      ![deviceId, runtimeSessionId, spaceId].every(validPart) ||
      (runtime !== "herdr" && runtime !== "tmux") ||
      ![tabId, paneId, terminalId].every(part => part === "" || validPart(part))
    ) {
      return null;
    }
    return {
      deviceId,
      runtime,
      runtimeSessionId,
      spaceId,
      ...(tabId ? { tabId } : {}),
      ...(paneId ? { paneId } : {}),
      ...(terminalId ? { terminalId } : {}),
    };
  } catch {
    return null;
  }
}

function validPart(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

module.exports = { decodeRuntimeId, runtimeProjectId, runtimeSessionId, runtimeTabId };
