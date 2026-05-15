import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { publishTmuxProject } from '@/lib/projects';
import { refreshUserProjects, requestAgentHealthRefresh } from '@/lib/broker';
import { hashToken } from '@/lib/tokens';

const windowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  target: z.string().trim().min(1).max(240),
  windowName: z.string().trim().min(1).max(120).optional(),
  ordinal: z.number().int().min(0).max(10000).optional()
});

const publishSchema = z.object({
  projectName: z.string().trim().min(1).max(80),
  tmuxSessionName: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(1000).optional(),
  windows: z.array(windowSchema).min(1).max(100)
});

function bearerToken(request: Request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || '';
}

export async function POST(request: Request) {
  const rawToken = bearerToken(request);
  if (!rawToken || rawToken.length > 512) {
    return NextResponse.json({ error: 'Missing agent token' }, { status: 401 });
  }

  const token = await prisma.agentToken.findFirst({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    select: { id: true, userId: true, name: true }
  });
  if (!token) {
    return NextResponse.json({ error: 'Invalid agent token' }, { status: 401 });
  }

  const parsed = publishSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid tmux publish payload' }, { status: 400 });
  }

  await prisma.agentToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date() }
  });

  try {
    const project = await publishTmuxProject({
      userId: token.userId,
      rootKey: token.name || 'Local device',
      projectName: parsed.data.projectName,
      sessionName: parsed.data.tmuxSessionName,
      path: parsed.data.path,
      windows: parsed.data.windows
    });
    refreshUserProjects(token.userId);
    // Tell the device's persistent agent to send a fresh health ping right
    // away — without this, the UI's missing-target detection has up to
    // HEALTH_INTERVAL_MS of stale tmuxSessions data after each publish and
    // can flag freshly-published tabs as missing.
    requestAgentHealthRefresh(token.userId, token.name || 'Local device');
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not publish tmux session';
    const status = message.includes('already bound') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
