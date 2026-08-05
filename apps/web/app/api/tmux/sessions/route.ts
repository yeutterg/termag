import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { listTmuxSessions, refreshSshHostsForUser, type TmuxDeviceSession } from "@/lib/broker";
import { prisma } from "@/lib/prisma";

function key(rootKey: string, value: string) {
  return `${rootKey}\u0000${value}`;
}

async function connectedTmuxTargets(userId: string) {
  const projects = await prisma.project.findMany({
    where: { userId },
    select: {
      rootKey: true,
      tmuxSessionName: true,
      sessions: { select: { tmuxName: true, tmuxWindowName: true } },
    },
  });
  return {
    sessions: new Set(
      projects.flatMap(project =>
        project.tmuxSessionName ? [key(project.rootKey, project.tmuxSessionName)] : []
      )
    ),
    windows: new Set(
      projects.flatMap(project =>
        project.sessions.flatMap(session => [
          key(project.rootKey, session.tmuxName),
          ...(session.tmuxWindowName ? [key(project.rootKey, session.tmuxWindowName)] : []),
        ])
      )
    ),
  };
}

function attachableSessions(
  sessions: TmuxDeviceSession[],
  connected: Awaited<ReturnType<typeof connectedTmuxTargets>>
) {
  return sessions
    .filter(session => session.name && !session.name.startsWith("termag-"))
    .filter(session => !connected.sessions.has(key(session.rootKey, session.name)))
    .map(session => ({
      ...session,
      windows: session.windows.filter(
        window => window.target && !connected.windows.has(key(session.rootKey, window.target))
      ),
    }))
    .filter(session => session.windows.length > 0);
}

export const GET = withAuth(async user => {
  await refreshSshHostsForUser(user.id, { broadcast: false });
  const [sessions, connected] = await Promise.all([
    listTmuxSessions(user.id),
    connectedTmuxTargets(user.id),
  ]);
  return NextResponse.json(attachableSessions(sessions, connected));
});
