import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
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
  const selectedRoots = body.rootKey && roots[body.rootKey] ? { [body.rootKey]: roots[body.rootKey] } : roots;

  // A rootKey is "owned" if the user has a token by that name. The agent on
  // that device is the authority on which paths are valid; the broker only
  // needs to know which device the project belongs to. This decouples the
  // web tier from the agent's TERMAG_AGENT_ROOTS env: a device can report
  // any rootKey via its health snapshot and the picker writes those values
  // straight through to projects without needing them mirrored in TERMAG_ROOTS.
  const ownedRootKey = body.rootKey
    ? await prisma.agentToken
        .findFirst({ where: { userId: user.id, name: body.rootKey, revokedAt: null }, select: { id: true } })
        .then((token) => (token ? body.rootKey : null))
    : null;

  const resolvedFromDirectory = body.directory ? resolveProjectDirectory(body.directory, selectedRoots) : null;
  const resolved = resolvedFromDirectory
    ? {
      rootKey: body.rootKey && !roots[body.rootKey] ? body.rootKey : resolvedFromDirectory.rootKey,
      relativePath: resolvedFromDirectory.relativePath
    }
    : body.rootKey && body.relativePath && (roots[body.rootKey] || ownedRootKey)
      ? { rootKey: body.rootKey, relativePath: normalizeRelativePath(body.relativePath) }
      : null;

  if (!resolved?.relativePath) {
    return NextResponse.json({ error: 'Directory must be inside a configured root' }, { status: 400 });
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
