import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { disconnectAgentToken } from '@/lib/broker';

export const DELETE = withAuth(async (user, _request: Request, { params }: { params: Promise<{ tokenId: string }> }) => {
  const { tokenId } = await params;
  const existing = await prisma.agentToken.findFirst({ where: { id: tokenId, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.agentToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() }
  });
  disconnectAgentToken(user.id, tokenId);
  return NextResponse.json({ ok: true });
});
