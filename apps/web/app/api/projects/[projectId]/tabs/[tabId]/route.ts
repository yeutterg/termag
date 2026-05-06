import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { killTmuxSessions } from '@/lib/broker';

type Params = { params: Promise<{ projectId: string; tabId: string }> };

const updateSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid tab payload' }, { status: 400 });
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } }
  });
  if (!tab) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const updated = await prisma.tab.update({
    where: { id: tab.id },
    data: { name: parsed.data.name.trim() },
    include: { session: true }
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (user, _request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } },
    include: {
      session: { select: { tmuxName: true } },
      project: { select: { _count: { select: { tabs: true } } } }
    }
  });
  if (!tab) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (tab.project._count.tabs <= 1) {
    return NextResponse.json({ error: 'Cannot delete the last tab in a project' }, { status: 409 });
  }
  await prisma.tab.delete({ where: { id: tab.id } });
  await killTmuxSessions(user.id, [tab.session?.tmuxName]);
  return NextResponse.json({ ok: true });
});
