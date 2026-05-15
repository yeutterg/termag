import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listProjects } from '@/lib/projects';
import { listTmuxSessions } from '@/lib/broker';

// JSON shape consumed by `termag list` and `termag attach` resolution. Keep
// the per-device structure stable — both CLI subcommands key off it. We use
// HTTP (not WS) because list is a single one-shot query.

type CliState = {
  devices: Array<{
    name: string;
    connected: boolean;
    version: string | null;
    projects: Array<{
      id: string;
      name: string;
      rootKey: string;
      relativePath: string;
      status: string;
      tabs: Array<{
        id: string;
        name: string;
        status: string;
        sessionId: string | null;
      }>;
    }>;
    rawTmuxSessions: Array<{ name: string; windowCount: number; path: string | null }>;
  }>;
};

export const GET = withAuth(async (user) => {
  const projects = await listProjects(user.id);
  const tokens = await prisma.agentToken.findMany({
    where: { userId: user.id, revokedAt: null },
    select: { name: true }
  });

  const tmuxByDevice = new Map<string, Array<{ name: string; windowCount: number; path: string | null }>>();
  const broker = (globalThis as { termagBroker?: { listTmuxSessions?: (userId: string) => Promise<Array<{ rootKey: string; name: string; windowCount?: number; path?: string }>> } }).termagBroker;
  if (broker?.listTmuxSessions) {
    try {
      const raw = await broker.listTmuxSessions(user.id);
      for (const session of raw) {
        const bucket = tmuxByDevice.get(session.rootKey) ?? [];
        bucket.push({
          name: session.name,
          windowCount: typeof session.windowCount === 'number' ? session.windowCount : 0,
          path: session.path ?? null
        });
        tmuxByDevice.set(session.rootKey, bucket);
      }
    } catch {
      // Broker timeouts shouldn't fail the whole listing.
    }
  }

  const liveDevices = await listLiveDevices(user.id);
  const deviceNames = new Set<string>([
    ...tokens.map((token) => token.name),
    ...projects.map((project) => project.rootKey),
    ...liveDevices.map((device) => device.name)
  ]);

  const state: CliState = {
    devices: [...deviceNames].sort().map((name) => {
      const live = liveDevices.find((device) => device.name === name);
      return {
        name,
        connected: Boolean(live?.connected),
        version: live?.version ?? null,
        projects: projects
          .filter((project) => project.rootKey === name)
          .map((project) => ({
            id: project.id,
            name: project.name,
            rootKey: project.rootKey,
            relativePath: project.relativePath,
            status: project.status,
            tabs: project.tabs.map((tab) => ({
              id: tab.id,
              name: tab.name,
              status: tab.status,
              sessionId: tab.session?.id ?? null
            }))
          })),
        rawTmuxSessions: filterTermagManagedOut(
          tmuxByDevice.get(name) ?? [],
          projects.filter((project) => project.rootKey === name)
        )
      };
    })
  };

  return NextResponse.json(state);
});

type LiveDevice = { name: string; connected: boolean; version: string | null };

async function listLiveDevices(userId: string): Promise<LiveDevice[]> {
  // The broker's status broadcast is the canonical source for connected
  // device state, but it's a WS push. For HTTP we synthesize from the in-
  // memory agents Map via the listTmuxSessions side effect plus the broker's
  // device-status accessor. For now: live devices = anything that has a tmux
  // listing returned (means an agent answered the tmux-list request).
  const broker = (globalThis as {
    termagBroker?: {
      listTmuxSessions?: (userId: string) => Promise<Array<{ rootKey: string }>>;
    };
  }).termagBroker;
  if (!broker?.listTmuxSessions) return [];
  try {
    const sessions = await broker.listTmuxSessions(userId);
    const names = new Set(sessions.map((s) => s.rootKey));
    return [...names].map((name) => ({ name, connected: true, version: null }));
  } catch {
    return [];
  }
}

function filterTermagManagedOut(
  raw: Array<{ name: string; windowCount: number; path: string | null }>,
  projects: Array<{ tmuxSessionName?: string | null }>
): Array<{ name: string; windowCount: number; path: string | null }> {
  const managed = new Set(
    projects
      .map((project) => project.tmuxSessionName?.trim())
      .filter((value): value is string => Boolean(value))
  );
  return raw.filter((session) => !managed.has(session.name));
}
