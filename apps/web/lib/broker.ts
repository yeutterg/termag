type Broker = {
  listTmuxSessions?: (userId: string) => Promise<TmuxDeviceSession[]>;
  refreshUser?: (userId: string) => void;
  killTmuxSession?: (userId: string, deviceName: string, tmuxSessionName: string, timeoutMs?: number) => Promise<boolean>;
  killTmuxWindow?: (userId: string, deviceName: string, tmuxName: string, timeoutMs?: number) => Promise<boolean>;
  killTmux: (userId: string, tmuxName: string, timeoutMs?: number) => Promise<boolean>;
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
  if (!live?.listTmuxSessions) return [];
  return live.listTmuxSessions(userId);
}

export function refreshUserProjects(userId: string) {
  broker()?.refreshUser?.(userId);
}

export async function killTmuxWindows(userId: string, targets: Array<{ rootKey: string; tmuxName: string | null | undefined }>) {
  const live = broker();
  if (!live) return;
  const validTargets = targets.filter((target): target is { rootKey: string; tmuxName: string } => Boolean(target.tmuxName));
  if (validTargets.length === 0) return;
  await Promise.all(validTargets.map((target) =>
    live.killTmuxWindow
      ? live.killTmuxWindow(userId, target.rootKey, target.tmuxName).catch(() => false)
      : live.killTmux(userId, target.tmuxName).catch(() => false)
  ));
}

export async function killTmuxProjectSessions(userId: string, targets: Array<{ rootKey: string; tmuxSessionName: string | null | undefined }>) {
  const live = broker();
  if (!live) return;
  const validTargets = targets.filter((target): target is { rootKey: string; tmuxSessionName: string } => Boolean(target.tmuxSessionName));
  if (validTargets.length === 0) return;
  await Promise.all(validTargets.map((target) =>
    live.killTmuxSession
      ? live.killTmuxSession(userId, target.rootKey, target.tmuxSessionName).catch(() => false)
      : live.killTmux(userId, target.tmuxSessionName).catch(() => false)
  ));
}

export async function killTmuxSessions(userId: string, tmuxNames: Array<string | null | undefined>) {
  const live = broker();
  if (!live) return;
  const targets = tmuxNames.filter((name): name is string => Boolean(name));
  if (targets.length === 0) return;
  await Promise.all(targets.map((name) => live.killTmux(userId, name).catch(() => false)));
}
