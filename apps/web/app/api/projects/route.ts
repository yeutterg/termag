import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { createProject, listProjects } from '@/lib/projects';
import { AGENT_DEFAULTS, DEFAULT_AGENT_TYPE, parseRoots } from '@/lib/defaults';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  rootKey: z.string().min(1),
  relativePath: z.string().min(1),
  agentType: z.string().default(DEFAULT_AGENT_TYPE),
  agentSpawnCommand: z.string().optional()
});

export async function GET() {
  const user = await requireUser();
  return NextResponse.json(await listProjects(user.id));
}

export async function POST(request: Request) {
  const user = await requireUser();
  const body = createSchema.parse(await request.json());
  const roots = parseRoots();
  if (!roots[body.rootKey]) {
    return NextResponse.json({ error: 'Unknown rootKey' }, { status: 400 });
  }
  if (!AGENT_DEFAULTS[body.agentType as keyof typeof AGENT_DEFAULTS] && !body.agentSpawnCommand) {
    return NextResponse.json({ error: 'Custom agent types require agentSpawnCommand' }, { status: 400 });
  }

  const project = await createProject({
    userId: user.id,
    name: body.name,
    rootKey: body.rootKey,
    relativePath: body.relativePath,
    agentType: body.agentType,
    agentSpawnCommand: body.agentSpawnCommand
  });
  return NextResponse.json(project, { status: 201 });
}
