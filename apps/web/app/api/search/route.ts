import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  const user = await requireUser();
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim();
  if (!q) return NextResponse.json([]);

  const chunks = await prisma.scrollbackChunk.findMany({
    where: {
      data: { contains: q },
      session: { project: { userId: user.id } }
    },
    include: {
      session: { include: { project: true, tab: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: 30
  });

  return NextResponse.json(chunks.map((chunk) => ({
    id: chunk.id,
    projectId: chunk.session.projectId,
    projectName: chunk.session.project.name,
    tabId: chunk.session.tabId,
    tabName: chunk.session.tab?.name ?? 'ctrl',
    excerpt: excerpt(chunk.data, q),
    createdAt: chunk.createdAt
  })));
}

function excerpt(data: string, q: string) {
  const idx = data.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return data.slice(0, 220);
  return data.slice(Math.max(0, idx - 90), Math.min(data.length, idx + q.length + 130));
}
