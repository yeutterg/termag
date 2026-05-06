import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { normalizeRelativePath, parseRoots } from '@/lib/defaults';
import { killTmuxSessions } from '@/lib/broker';

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  rootKey: z.string().trim().min(1).optional(),
  relativePath: z.string().trim().min(1).optional(),
  agentSpawnCommand: z.string().trim().min(1).max(1000).optional()
});

type Params = { params: Promise<{ projectId: string }> };

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId } = await params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid project payload' }, { status: 400 });
  const body = parsed.data;
  if (body.rootKey && !parseRoots()[body.rootKey]) {
    return NextResponse.json({ error: 'Unknown rootKey' }, { status: 400 });
  }
  const existing = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const relativePath = body.relativePath ? normalizeRelativePath(body.relativePath) : undefined;
  if (body.relativePath && !relativePath) {
    return NextResponse.json({ error: 'Project path is required' }, { status: 400 });
  }
  try {
    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        ...body,
        relativePath
      },
      include: { tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } }, sessions: true }
    });
    return NextResponse.json(project);
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'Project name already exists' }, { status: 409 });
    }
    throw error;
  }
});

export const DELETE = withAuth(async (user, _request: Request, { params }: Params) => {
  const { projectId } = await params;
  const existing = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id },
    include: { sessions: { select: { tmuxName: true } } }
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.project.delete({ where: { id: projectId } });
  await killTmuxSessions(user.id, existing.sessions.map((s) => s.tmuxName));
  return NextResponse.json({ ok: true });
});
