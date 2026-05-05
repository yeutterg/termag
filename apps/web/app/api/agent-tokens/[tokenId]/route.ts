import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function DELETE(_request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const user = await requireUser();
  const { tokenId } = await params;
  const existing = await prisma.agentToken.findFirst({ where: { id: tokenId, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.agentToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() }
  });
  return NextResponse.json({ ok: true });
}
