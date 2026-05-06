import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createTab } from '@/lib/projects';

export const POST = withAuth(async (user, _request: Request, { params }: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await params;
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const tab = await createTab(project.id);
  return NextResponse.json(tab, { status: 201 });
});
