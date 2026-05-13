import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createRawToken, hashToken, tokenPrefix } from '@/lib/tokens';

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Explicit select to keep tokenHash off the wire.
const tokenView = {
  id: true,
  name: true,
  tokenPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  defaultRootKey: true,
  defaultRelativePath: true
} as const;

export const GET = withAuth(async (user) => {
  const tokens = await prisma.agentToken.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: tokenView
  });
  return NextResponse.json(tokens);
});

export const POST = withAuth(async (user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid token payload' }, { status: 400 });
  }
  const raw = createRawToken();
  const token = await prisma.agentToken.create({
    data: {
      userId: user.id,
      name: parsed.data.name,
      tokenHash: hashToken(raw),
      tokenPrefix: tokenPrefix(raw)
    },
    select: tokenView
  });
  return NextResponse.json({ ...token, token: raw }, { status: 201 });
});
