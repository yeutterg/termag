type Broker = {
  killTmux: (userId: string, tmuxName: string, timeoutMs?: number) => Promise<boolean>;
};

function broker(): Broker | null {
  return (globalThis as { termagBroker?: Broker }).termagBroker ?? null;
}

export async function killTmuxSessions(userId: string, tmuxNames: Array<string | null | undefined>) {
  const live = broker();
  if (!live) return;
  const targets = tmuxNames.filter((name): name is string => Boolean(name));
  if (targets.length === 0) return;
  await Promise.all(targets.map((name) => live.killTmux(userId, name).catch(() => false)));
}
