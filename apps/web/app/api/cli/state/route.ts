import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listConnectedDevices } from "@/lib/broker";
import { listProjects } from "@/lib/runtime-projects";

// One-shot state for `termag list` and `termag attach`. Protocol v2 inventory
// already contains every tmux/Herdr target, so there is no second namespace.
export const GET = withAuth(async user => {
  const [projects, tokens] = await Promise.all([
    listProjects(user.id),
    prisma.agentToken.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { id: true, name: true },
    }),
  ]);
  const live = listConnectedDevices(user.id);
  return NextResponse.json({
    devices: tokens.map(token => {
      const status = live.find(device => device.deviceId === token.id);
      return {
        name: token.name,
        connected: Boolean(status?.connected),
        version: status?.version ?? null,
        kind: "agent" as const,
        deviceId: token.id,
        projects: projects
          .filter(project => project.deviceId === token.id)
          .map(project => ({
            id: project.id,
            name: project.name,
            rootKey: project.rootKey,
            relativePath: project.relativePath,
            status: project.status,
            tabs: project.tabs.map(tab => ({
              id: tab.id,
              name: tab.name,
              status: tab.status,
              sessionId: tab.session?.id ?? null,
            })),
          })),
        rawTmuxSessions: [],
      };
    }),
  });
});
