type Broker = {
  listDirectory?: (
    userId: string,
    deviceName: string,
    rootKey: string,
    relativePath: string
  ) => Promise<DirectoryListing>;
  connectedDevices?: (userId: string) => ConnectedDevice[];
  disconnectAgentToken?: (userId: string, tokenId: string) => void;
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
  getCaffeinateStatus?: (userId: string, deviceName: string) => Promise<CaffeinateState | null>;
  mutateRuntime?: (
    userId: string,
    deviceName: string,
    operation: RuntimeOperation,
    payload: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<Record<string, unknown>>;
  gitOperation?: (
    userId: string,
    deviceName: string,
    operation: GitOperation,
    payload: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<GitOperationResult>;
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

export type GitOperation =
  | "git.status"
  | "git.branch"
  | "git.commit"
  | "git.push"
  | "git.pull"
  | "git.stage";

export type GitOperationResult = {
  ok: boolean;
  exitCode: number | null;
  output: string;
  truncated?: boolean;
};

export type ConnectedDevice = {
  name: string;
  connected: boolean;
  version?: string | null;
  streamCount?: number;
  uptimeSec?: number;
  memMb?: number;
  memPeakMb?: number;
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

function broker(): Broker | null {
  return (globalThis as { termagBroker?: Broker }).termagBroker ?? null;
}

export function listConnectedDevices(userId: string): ConnectedDevice[] {
  return broker()?.connectedDevices?.(userId) ?? [];
}

export function disconnectAgentToken(userId: string, tokenId: string) {
  broker()?.disconnectAgentToken?.(userId, tokenId);
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
  timeoutMs = 10_000
) {
  const live = broker();
  if (!live?.mutateRuntime) {
    throw new Error("Agent offline or does not support runtime mutations");
  }
  return live.mutateRuntime(userId, deviceName, operation, payload, timeoutMs);
}

export async function runGitOperation(
  userId: string,
  deviceName: string,
  operation: GitOperation,
  payload: Record<string, unknown>,
  timeoutMs = 35_000
): Promise<GitOperationResult> {
  const live = broker();
  if (!live?.gitOperation) {
    throw new Error("Agent offline or does not support git operations");
  }
  return live.gitOperation(userId, deviceName, operation, payload, timeoutMs);
}

export async function acquirePowerLeaseOnDevice(
  userId: string,
  deviceName: string,
  leaseId: string,
  mode: "terminals-awake" | "display-awake" | "ac-awake",
  reason: string,
  durationMs: number,
  renew = false
) {
  const live = broker();
  if (!live?.acquirePowerLease) {
    throw new Error("Agent offline or does not support power leases");
  }
  return live.acquirePowerLease(userId, deviceName, leaseId, mode, reason, durationMs, renew);
}

export async function releasePowerLeaseOnDevice(
  userId: string,
  deviceName: string,
  leaseId: string
) {
  const live = broker();
  if (!live?.releasePowerLease) {
    throw new Error("Agent offline or does not support power leases");
  }
  return live.releasePowerLease(userId, deviceName, leaseId);
}

export async function getCaffeinateStatusOnDevice(userId: string, deviceName: string) {
  const live = broker();
  if (!live?.getCaffeinateStatus) {
    throw new Error("Agent offline or does not support power leases");
  }
  return live.getCaffeinateStatus(userId, deviceName);
}
