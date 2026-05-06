import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const schema = z.object({ theme: z.enum(['system', 'light', 'dark']) });

export const PATCH = withAuth(async (user, request: Request) => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid theme payload' }, { status: 400 });
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data: { theme: parsed.data.theme } });
  return NextResponse.json({ theme: updated.theme });
});
