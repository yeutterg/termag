import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { createProject, listProjects } from '@/lib/projects';
import { AGENT_DEFAULTS, DEFAULT_AGENT_TYPE, normalizeRelativePath, parseRoots, resolveProjectDirectory } from '@/lib/defaults';

const agentSchema = z.object({
  agentType: z.string().trim().min(1).max(80).optional(),
  label: z.string().trim().min(1).max(80).optional(),
  spawnCommand: z.string().trim().min(1).max(1000).optional(),
  agentSpawnCommand: z.string().trim().min(1).max(1000).optional()
});
type AgentInput = z.infer<typeof agentSchema>;

const createSchema = z.object({
  name: z.string().trim().max(80).optional(),
  directory: z.string().trim().min(1).optional(),
  rootKey: z.string().trim().min(1).optional(),
  relativePath: z.string().trim().min(1).optional(),
  agentType: z.string().trim().min(1).default(DEFAULT_AGENT_TYPE),
  agentTypes: z.array(z.string().trim().min(1)).min(1).max(4).optional(),
  agents: z.array(agentSchema).min(1).max(12).optional(),
  agentSpawnCommand: z.string().trim().min(1).max(1000).optional()
});

function defaultProjectName(relativePath: string) {
  const parts = relativePath.split('/').filter(Boolean);
  return parts.at(-1) || 'Untitled project';
}

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
  if (body.rootKey && !roots[body.rootKey]) {
    return NextResponse.json({ error: 'Unknown device root' }, { status: 400 });
  }
  const selectedRoots = body.rootKey ? { [body.rootKey]: roots[body.rootKey] } : roots;

  const resolved = body.directory
    ? resolveProjectDirectory(body.directory, selectedRoots)
    : body.rootKey && body.relativePath
      ? { rootKey: body.rootKey, relativePath: normalizeRelativePath(body.relativePath) }
      : null;

  if (!resolved?.relativePath) {
    return NextResponse.json({ error: 'Project path is required' }, { status: 400 });
  }
  if (!roots[resolved.rootKey]) {
    return NextResponse.json({ error: 'Unknown device root' }, { status: 400 });
  }

  const agents: AgentInput[] = body.agents?.length
    ? body.agents
    : [...new Set(body.agentTypes?.length ? body.agentTypes : [body.agentType])].map((agentType) => ({
      agentType,
      agentSpawnCommand: body.agentSpawnCommand
    }));
  if (
    agents.some((agent) => {
      const agentType = agent.agentType || 'custom';
      const spawnCommand = agent.spawnCommand || agent.agentSpawnCommand;
      return !AGENT_DEFAULTS[agentType as keyof typeof AGENT_DEFAULTS] && !spawnCommand;
    })
  ) {
    return NextResponse.json({ error: 'Custom agents require a spawn command' }, { status: 400 });
  }

  try {
    const primaryAgent = agents[0];
    const project = await createProject({
      userId: user.id,
      name: body.name || defaultProjectName(resolved.relativePath),
      rootKey: resolved.rootKey,
      relativePath: resolved.relativePath,
      agentType: primaryAgent.agentType,
      agentSpawnCommand: primaryAgent.spawnCommand || primaryAgent.agentSpawnCommand,
      agents: agents.map((agent) => ({
        agentType: agent.agentType,
        label: agent.label,
        agentSpawnCommand: agent.spawnCommand || agent.agentSpawnCommand
      }))
    });
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'Project name already exists' }, { status: 409 });
    }
    throw error;
  }
});
