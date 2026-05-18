import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listProjects } from '@/lib/projects';
import { listConnectedDevices, listTmuxSessions } from '@/lib/broker';

// JSON shape consumed by `termag list` and `termag attach` resolution. Keep
// the per-device structure stable — both CLI subcommands key off it. We use
// HTTP (not WS) because list is a single one-shot query.

type CliState = {
  devices: Array<{
    name: string;
    connected: boolean;
    version: string | null;
    // "agent" or "ssh" — lets `termag list` label ssh hosts distinctly.
    // Field is optional/defaulted so older CLIs keep working with newer
    // brokers (and vice versa).
    kind?: 'agent' | 'ssh';
    lastError?: string | null;
    // SshHost.id for ssh devices; needed by the CLI to construct the WS
    // attach URL. Null for agent-backed devices (those route by name).
    deviceId?: string | null;
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
  try {
    const raw = await listTmuxSessions(user.id);
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

  // Connected-device list comes straight from the broker's agents Map — an
  // agent that's connected but hasn't reported any tmux sessions yet still
  // shows up correctly. (Earlier version derived "connected" from listTmux
  // results and missed this case.)
  const liveDevices = listConnectedDevices(user.id);
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
        kind: live?.kind || 'agent',
        lastError: live?.lastError ?? null,
        deviceId: live?.deviceId ?? null,
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
