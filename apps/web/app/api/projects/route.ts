import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { createProject, listProjects } from '@/lib/projects';
import { AGENT_DEFAULTS, DEFAULT_AGENT_TYPE, normalizeRelativePath, parseRoots } from '@/lib/defaults';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rootKey: z.string().trim().min(1),
  relativePath: z.string().trim().min(1),
  agentType: z.string().trim().min(1).default(DEFAULT_AGENT_TYPE),
  agentSpawnCommand: z.string().trim().min(1).max(1000).optional()
});

export const GET = withAuth(async (user) => {
  return NextResponse.json(await listProjects(user.id));
});

export const POST = withAuth(async (user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid project payload' }, { status: 400 });
  }
  const body = parsed.data;
  const roots = parseRoots();
  if (!roots[body.rootKey]) {
    return NextResponse.json({ error: 'Unknown rootKey' }, { status: 400 });
  }
  const relativePath = normalizeRelativePath(body.relativePath);
  if (!relativePath) {
    return NextResponse.json({ error: 'Project path is required' }, { status: 400 });
  }
  if (!AGENT_DEFAULTS[body.agentType as keyof typeof AGENT_DEFAULTS] && !body.agentSpawnCommand) {
    return NextResponse.json({ error: 'Custom agent types require agentSpawnCommand' }, { status: 400 });
  }

  try {
    const project = await createProject({
      userId: user.id,
      name: body.name,
      rootKey: body.rootKey,
      relativePath,
      agentType: body.agentType,
      agentSpawnCommand: body.agentSpawnCommand
    });
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'Project name already exists' }, { status: 409 });
    }
    throw error;
  }
});
