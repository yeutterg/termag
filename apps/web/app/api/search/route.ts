import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const GET = withAuth(async (user, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim();
  if (!q || q.length < 2) return NextResponse.json([]);
  if (q.length > 200) return NextResponse.json({ error: 'Search query too long' }, { status: 400 });

  // Search is scoped to project-anchored scrollback only. SSH-host
  // scrollback exists in the same table but doesn't have a Project to
  // attribute it to in the UI today; surfacing those rows would need a
  // separate result type. Filtering on `project: { userId }` cleanly
  // excludes SSH chunks (their session.projectId is null).
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

  return NextResponse.json(chunks
    .filter((chunk) => chunk.session.project) // narrows for TS; query already excluded null
    .map((chunk) => ({
      id: chunk.id,
      projectId: chunk.session.projectId,
      projectName: chunk.session.project!.name,
      tabId: chunk.session.tabId,
      tabName: chunk.session.tab?.name ?? 'ctrl',
      excerpt: excerpt(chunk.data, q),
      createdAt: chunk.createdAt
    })));
});

function excerpt(data: string, q: string) {
  const idx = data.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return data.slice(0, 220);
  return data.slice(Math.max(0, idx - 90), Math.min(data.length, idx + q.length + 130));
}
