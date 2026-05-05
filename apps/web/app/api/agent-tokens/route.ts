import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createRawToken, hashToken, tokenPrefix } from '@/lib/tokens';

const createSchema = z.object({ name: z.string().min(1).max(80) });

export async function GET() {
  const user = await requireUser();
  const tokens = await prisma.agentToken.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, tokenPrefix: true, createdAt: true, lastUsedAt: true }
  });
  return NextResponse.json(tokens);
}

export async function POST(request: Request) {
  const user = await requireUser();
  const { name } = createSchema.parse(await request.json());
  const raw = createRawToken();
  const token = await prisma.agentToken.create({
    data: {
      userId: user.id,
      name,
      tokenHash: hashToken(raw),
      tokenPrefix: tokenPrefix(raw)
    },
    select: { id: true, name: true, tokenPrefix: true, createdAt: true, lastUsedAt: true }
  });
  return NextResponse.json({ ...token, token: raw }, { status: 201 });
}
