import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { listTmuxSessions } from '@/lib/broker';
import { createAttachedTmuxProject } from '@/lib/projects';
import { prisma } from '@/lib/prisma';

const attachSchema = z.object({
  rootKey: z.string().trim().min(1),
  sessionName: z.string().trim().min(1)
});

function key(rootKey: string, value: string) {
  return `${rootKey}\u0000${value}`;
}

export const POST = withAuth(async (user, request: Request) => {
  const parsed = attachSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid tmux attach payload' }, { status: 400 });
  }

  const { rootKey, sessionName } = parsed.data;
  const existing = await prisma.project.findFirst({
    where: { userId: user.id, rootKey, tmuxSessionName: sessionName },
    select: { id: true }
  });
  if (existing) {
    return NextResponse.json({ error: 'That tmux session is already attached' }, { status: 409 });
  }

  const sessions = await listTmuxSessions(user.id);
  const session = sessions.find((item) => item.rootKey === rootKey && item.name === sessionName);
  if (!session || session.name.startsWith('termag-')) {
    return NextResponse.json({ error: 'tmux session is not available' }, { status: 404 });
  }

  const connectedWindows = new Set(
    (await prisma.session.findMany({
      where: { project: { userId: user.id, rootKey } },
      select: { tmuxName: true, tmuxWindowName: true }
    })).flatMap((item) => [
      key(rootKey, item.tmuxName),
      ...(item.tmuxWindowName ? [key(rootKey, item.tmuxWindowName)] : [])
    ])
  );
  const windows = session.windows.filter((window) => window.target && !connectedWindows.has(key(rootKey, window.target)));
  if (windows.length === 0) {
    return NextResponse.json({ error: 'All windows in that tmux session are already attached' }, { status: 409 });
  }

  try {
    const project = await createAttachedTmuxProject({
      userId: user.id,
      rootKey,
      sessionName,
      path: session.path,
      windows: windows.map((window) => ({
        name: window.name,
        target: window.target,
        windowName: window.id || String(window.index),
        ordinal: window.index + 1
      }))
    });
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'That tmux session is already attached' }, { status: 409 });
    }
    throw error;
  }
});
