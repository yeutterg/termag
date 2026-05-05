import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { normalizeRelativePath, parseRoots } from '@/lib/defaults';

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  rootKey: z.string().min(1).optional(),
  relativePath: z.string().min(1).optional(),
  agentSpawnCommand: z.string().min(1).optional()
});

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUser();
  const { projectId } = await params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid project payload' }, { status: 400 });
  const body = parsed.data;
  if (body.rootKey && !parseRoots()[body.rootKey]) {
    return NextResponse.json({ error: 'Unknown rootKey' }, { status: 400 });
  }
  const existing = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const project = await prisma.project.update({
    where: { id: projectId },
    data: {
      ...body,
      relativePath: body.relativePath ? normalizeRelativePath(body.relativePath) : undefined
    },
    include: { tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } }, sessions: true }
  });
  return NextResponse.json(project);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUser();
  const { projectId } = await params;
  const existing = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.project.delete({ where: { id: projectId } });
  return NextResponse.json({ ok: true });
}
