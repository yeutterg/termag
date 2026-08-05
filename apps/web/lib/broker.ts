type Broker = {
  listTmuxSessions?: (userId: string) => Promise<TmuxDeviceSession[]>;
  listDirectory?: (
    userId: string,
    deviceName: string,
    rootKey: string,
    relativePath: string
  ) => Promise<DirectoryListing>;
  connectedDevices?: (userId: string) => ConnectedDevice[];
  refreshUser?: (userId: string) => void;
  requestHealthRefresh?: (userId: string, deviceName: string) => void;
  killTmuxSession?: (
    userId: string,
    deviceName: string,
    tmuxSessionName: string,
    timeoutMs?: number
  ) => Promise<boolean>;
  killTmuxWindow?: (
    userId: string,
    deviceName: string,
    tmuxName: string,
    timeoutMs?: number
  ) => Promise<boolean>;
  renameTmuxWindow?: (
    userId: string,
    deviceName: string,
    tmuxName: string,
    name: string,
    timeoutMs?: number
  ) => Promise<{ tmuxName?: string; tmuxWindowName?: string } | null>;
  disconnectAgentToken?: (userId: string, tokenId: string) => void;
  killTmux: (userId: string, tmuxName: string, timeoutMs?: number) => Promise<boolean>;
  refreshSshHosts?: (userId: string, options?: { broadcast?: boolean }) => Promise<void>;
  probeSshHost?: (
    userId: string,
    hostId: string
  ) => Promise<{
    ok: boolean;
    error?: string | null;
    sessions?: Array<{ name: string; windowCount: number; path: string }>;
  }>;
  forgetSshHost?: (userId: string, hostId: string) => void;
  startCaffeinate?: (
    userId: string,
    deviceName: string,
    mode: "terminals-awake" | "display-awake" | "ac-awake" | "while-task" | "timed",
    reason: string,
    durationMs?: number
  ) => Promise<{ success: boolean; error?: string; state?: CaffeinateState }>;
  stopCaffeinate?: (
    userId: string,
    deviceName: string
  ) => Promise<{ success: boolean; error?: string; state?: CaffeinateState }>;
  getCaffeinateStatus?: (userId: string, deviceName: string) => Promise<CaffeinateState | null>;
  acquirePowerLease?: (
    userId: string,
    deviceName: string,
    leaseId: string,
    mode: "terminals-awake" | "display-awake" | "ac-awake",
    reason: string,
    durationMs: number,
    renew?: boolean
  ) => Promise<{ success: boolean; error?: string; state?: CaffeinateState }>;
  releasePowerLease?: (
    userId: string,
    deviceName: string,
    leaseId: string
  ) => Promise<{ success: boolean; error?: string; state?: CaffeinateState }>;
  mutateRuntime?: (
    userId: string,
    deviceName: string,
    operation: RuntimeOperation,
    payload: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<Record<string, unknown>>;
};

export type RuntimeOperation =
  | "runtime.create-session"
  | "runtime.create-space"
  | "runtime.create-tab"
  | "runtime.rename-space"
  | "runtime.rename-tab"
  | "runtime.rename-pane"
  | "runtime.close-tab"
  | "runtime.close-pane"
  | "runtime.close-space"
  | "runtime.close-session";

export type ConnectedDevice = {
  name: string;
  connected: boolean;
  lastSeenAt: string | null;
  version?: string | null;
  fake?: boolean;
  streamCount?: number;
  uptimeSec?: number;
  memMb?: number;
  memPeakMb?: number;
  // "agent" (default, omitted on the wire) or "ssh". Lets the UI render
  // an SSH-host badge and the CLI label hosts in `termag list`.
  kind?: "agent" | "ssh";
  lastError?: string | null;
  // Stable id for the device — AgentToken.id for agents, SshHost.id for
  // ssh hosts. The CLI uses this to construct the WS attach URL without
  // having to re-resolve the name on the server.
  deviceId?: string | null;
};

export type CaffeinateState = {
  mode: string;
  isActive?: boolean;
  active?: boolean;
  reason?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  pid?: number | null;
  endsAtUnixMs?: number | null;
  leaseCount?: number;
};

export type DirectoryListing = {
  rootKey: string;
  relativePath: string;
  absolutePath: string;
  parent: { rootKey: string; relativePath: string } | null;
  entries: Array<{ name: string; isDir: boolean }>;
  truncated: boolean;
  roots: Record<string, string>;
};

export type TmuxDeviceSession = {
  rootKey: string;
  name: string;
  path?: string;
  windowCount?: number;
  windows: Array<{
    index: number;
    id: string;
    name: string;
    target: string;
    path?: string;
  }>;
};

function broker(): Broker | null {
  return (globalThis as { termagBroker?: Broker }).termagBroker ?? null;
}

export async function listTmuxSessions(userId: string): Promise<TmuxDeviceSession[]> {
  const live = broker();
  if (!live?.listTmuxSessions) {
    return [];
  }
  return live.listTmuxSessions(userId);
}

export function listConnectedDevices(userId: string): ConnectedDevice[] {
  return broker()?.connectedDevices?.(userId) ?? [];
}

export function refreshUserProjects(userId: string) {
  broker()?.refreshUser?.(userId);
}

// Fire-and-forget — asks a specific device's agent to send a fresh health
// ping immediately. Used right after a publish so the UI sees the new tmux
// state without waiting for the next scheduled health tick.
export function requestAgentHealthRefresh(userId: string, deviceName: string) {
  broker()?.requestHealthRefresh?.(userId, deviceName);
}

export async function killTmuxWindows(
  userId: string,
  targets: Array<{ rootKey: string; tmuxName: string | null | undefined }>
) {
  const live = broker();
  if (!live) {
    return;
  }
  const validTargets = targets.filter((target): target is { rootKey: string; tmuxName: string } =>
    Boolean(target.tmuxName)
  );
  if (validTargets.length === 0) {
    return;
  }
  await Promise.all(
    validTargets.map(target =>
      live.killTmuxWindow
        ? live.killTmuxWindow(userId, target.rootKey, target.tmuxName).catch(() => false)
        : live.killTmux(userId, target.tmuxName).catch(() => false)
    )
  );
}

export async function killTmuxProjectSessions(
  userId: string,
  targets: Array<{ rootKey: string; tmuxSessionName: string | null | undefined }>
) {
  const live = broker();
  if (!live) {
    return;
  }
  const validTargets = targets.filter(
    (target): target is { rootKey: string; tmuxSessionName: string } =>
      Boolean(target.tmuxSessionName)
  );
  if (validTargets.length === 0) {
    return;
  }
  await Promise.all(
    validTargets.map(target =>
      live.killTmuxSession
        ? live.killTmuxSession(userId, target.rootKey, target.tmuxSessionName).catch(() => false)
        : live.killTmux(userId, target.tmuxSessionName).catch(() => false)
    )
  );
}

export async function renameTmuxWindow(
  userId: string,
  target: { rootKey: string; tmuxName: string | null | undefined; name: string }
) {
  const live = broker();
  if (!live?.renameTmuxWindow || !target.tmuxName || !target.name.trim()) {
    return null;
  }
  return live
    .renameTmuxWindow(userId, target.rootKey, target.tmuxName, target.name.trim())
    .catch(() => null);
}

export function disconnectAgentToken(userId: string, tokenId: string) {
  broker()?.disconnectAgentToken?.(userId, tokenId);
}

export async function killTmuxSessions(
  userId: string,
  tmuxNames: Array<string | null | undefined>
) {
  const live = broker();
  if (!live) {
    return;
  }
  const targets = tmuxNames.filter((name): name is string => Boolean(name));
  if (targets.length === 0) {
    return;
  }
  await Promise.all(targets.map(name => live.killTmux(userId, name).catch(() => false)));
}

export async function listDeviceDirectory(
  userId: string,
  deviceName: string,
  rootKey: string,
  relativePath: string
): Promise<DirectoryListing> {
  const live = broker();
  if (!live?.listDirectory) {
    throw new Error("Agent offline");
  }
  return live.listDirectory(userId, deviceName, rootKey, relativePath);
}

export async function mutateRuntime(
  userId: string,
  deviceName: string,
  operation: RuntimeOperation,
  payload: Record<string, unknown>,
  timeoutMs = 10000
) {
  const live = broker();
  if (!live?.mutateRuntime) {
    throw new Error("Agent offline or does not support runtime mutations");
  }
  return live.mutateRuntime(userId, deviceName, operation, payload, timeoutMs);
}

/**
 * Reload SshHost rows for this user into the broker's in-memory poller.
 * Idempotent — call from any route that mutates the SshHost table so the
 * broker doesn't have to wait for its 30s reconcile tick.
 */
export async function refreshSshHostsForUser(
  userId: string,
  options?: { broadcast?: boolean }
): Promise<void> {
  await broker()?.refreshSshHosts?.(userId, options);
}

/**
 * One-shot probe of a single registered SshHost: reachability + tmux list.
 * Persists results back to the DB (lastSeenAt / lastError) and returns the
 * probe outcome so the API caller can echo it to the user.
 */
export async function probeRegisteredSshHost(userId: string, hostId: string) {
  return broker()?.probeSshHost?.(userId, hostId) ?? { ok: false, error: "broker offline" };
}

/**
 * Drop in-memory state for an SshHost that's about to be deleted. The DB
 * row is the source of truth; this cleanup just stops the poller from
 * resurrecting the host before the next reconcile tick.
 */
export function forgetSshHostInBroker(userId: string, hostId: string): void {
  broker()?.forgetSshHost?.(userId, hostId);
}

/**
 * Start caffeinate (prevent sleep) on a device
 */
export async function startCaffeinateOnDevice(
  userId: string,
  deviceName: string,
  mode: "terminals-awake" | "display-awake" | "ac-awake" | "while-task" | "timed",
  reason: string,
  durationMs?: number
): Promise<{ success: boolean; error?: string; state?: CaffeinateState }> {
  const live = broker();
  if (!live?.startCaffeinate) {
    throw new Error("Broker offline or does not support caffeinate");
  }
  return live.startCaffeinate(userId, deviceName, mode, reason, durationMs);
}

/**
 * Stop caffeinate on a device
 */
export async function stopCaffeinateOnDevice(
  userId: string,
  deviceName: string
): Promise<{ success: boolean; error?: string; state?: CaffeinateState }> {
  const live = broker();
  if (!live?.stopCaffeinate) {
    throw new Error("Broker offline or does not support caffeinate");
  }
  return live.stopCaffeinate(userId, deviceName);
}

/**
 * Get caffeinate status from a device
 */
export async function getCaffeinateStatusOnDevice(
  userId: string,
  deviceName: string
): Promise<CaffeinateState | null> {
  const live = broker();
  if (!live?.getCaffeinateStatus) {
    throw new Error("Broker offline or does not support caffeinate");
  }
  return live.getCaffeinateStatus(userId, deviceName);
}

export async function acquirePowerLeaseOnDevice(
  userId: string,
  deviceName: string,
  leaseId: string,
  mode: "terminals-awake" | "display-awake" | "ac-awake",
  reason: string,
  durationMs: number,
  renew = false
): Promise<{ success: boolean; error?: string; state?: CaffeinateState }> {
  const live = broker();
  if (!live?.acquirePowerLease) {
    throw new Error("Broker does not support power leases");
  }
  return live.acquirePowerLease(userId, deviceName, leaseId, mode, reason, durationMs, renew);
}

export async function releasePowerLeaseOnDevice(
  userId: string,
  deviceName: string,
  leaseId: string
): Promise<{ success: boolean; error?: string; state?: CaffeinateState }> {
  const live = broker();
  if (!live?.releasePowerLease) {
    throw new Error("Broker does not support power leases");
  }
  return live.releasePowerLease(userId, deviceName, leaseId);
}
