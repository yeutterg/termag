import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJsonBody, withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { killTmuxWindows, renameTmuxWindow } from '@/lib/broker';

type Params = { params: Promise<{ projectId: string; tabId: string }> };

const updateSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = updateSchema.safeParse(bodyResult.data);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid tab payload' }, { status: 400 });
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } },
    include: {
      session: { select: { id: true, tmuxName: true, tmuxManaged: true } },
      project: { select: { rootKey: true } }
    }
  });
  if (!tab) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let tmuxUpdate: { tmuxName?: string; tmuxWindowName?: string } | null = null;
  if (tab.session && tab.session.tmuxManaged !== false) {
    tmuxUpdate = await renameTmuxWindow(user.id, {
      rootKey: tab.project.rootKey,
      tmuxName: tab.session?.tmuxName,
      name: parsed.data.name.trim()
    });
  }
  const sessionUpdate = tab.session && tab.session.tmuxManaged !== false
    ? {
      update: {
        tmuxName: tmuxUpdate?.tmuxName ?? tab.session.tmuxName,
        tmuxWindowName: tmuxUpdate?.tmuxWindowName || parsed.data.name.trim()
      }
    }
    : undefined;
  const updated = await prisma.tab.update({
    where: { id: tab.id },
    data: {
      name: parsed.data.name.trim(),
      session: sessionUpdate
    },
    include: { session: true }
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (user, _request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } },
    include: {
      session: { select: { tmuxName: true, tmuxManaged: true } },
      project: { select: { rootKey: true, _count: { select: { tabs: true } } } }
    }
  });
  if (!tab) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (tab.project._count.tabs <= 1) {
    return NextResponse.json({ error: 'Cannot delete the last tab in a project' }, { status: 409 });
  }
  await prisma.tab.delete({ where: { id: tab.id } });
  if (tab.session?.tmuxManaged !== false) {
    await killTmuxWindows(user.id, [{ rootKey: tab.project.rootKey, tmuxName: tab.session?.tmuxName }]);
  }
  return NextResponse.json({ ok: true });
});
