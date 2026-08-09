import "server-only";

export type RuntimeIdentity = {
  deviceId: string;
  runtime: "herdr" | "tmux";
  runtimeSessionId: string;
  spaceId: string;
  tabId?: string;
  paneId?: string;
  terminalId?: string;
};

const PREFIX = {
  project: "rp_",
  tab: "rt_",
  session: "rs_",
} as const;

type RuntimeIdentityKind = keyof typeof PREFIX;

function encode(kind: RuntimeIdentityKind, identity: RuntimeIdentity): string {
  const payload = [
    identity.deviceId,
    identity.runtime,
    identity.runtimeSessionId,
    identity.spaceId,
    identity.tabId ?? "",
    identity.paneId ?? "",
    identity.terminalId ?? "",
  ];
  return `${PREFIX[kind]}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

export function runtimeProjectId(identity: RuntimeIdentity): string {
  return encode("project", identity);
}

export function runtimeTabId(identity: RuntimeIdentity): string {
  return encode("tab", identity);
}

export function runtimeSessionId(identity: RuntimeIdentity): string {
  return encode("session", identity);
}

export function decodeRuntimeId(
  value: string,
  expected?: RuntimeIdentityKind
): RuntimeIdentity | null {
  if (typeof value !== "string" || value.length > 4096) {
    return null;
  }
  const kind = (Object.keys(PREFIX) as RuntimeIdentityKind[]).find(key =>
    value.startsWith(PREFIX[key])
  );
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
      ![tabId, paneId, terminalId].every(value => value === "" || validPart(value))
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

function validPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
