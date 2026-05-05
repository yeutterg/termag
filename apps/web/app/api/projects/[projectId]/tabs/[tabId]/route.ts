import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; tabId: string }> }
) {
  const user = await requireUser();
  const { projectId, tabId } = await params;
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } }
  });
  if (!tab) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.tab.delete({ where: { id: tab.id } });
  return NextResponse.json({ ok: true });
}
