import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const schema = z.object({ theme: z.enum(['system', 'light', 'dark']) });

export async function PATCH(request: Request) {
  const user = await requireUser();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid theme payload' }, { status: 400 });
  }
  const { theme } = parsed.data;
  const updated = await prisma.user.update({ where: { id: user.id }, data: { theme } });
  return NextResponse.json({ theme: updated.theme });
}
