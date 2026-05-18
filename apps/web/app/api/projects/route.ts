import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJsonBody, withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
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
  agentTypes: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
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
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = createSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid project payload' }, { status: 400 });
  }
  const body = parsed.data;

  // Reject path traversal in relativePath BEFORE normalization. The agent's
  // resolveCwd throws on '..' segments but normalizeRelativePath silently
  // strips them, so a payload like '../etc' would land the project at 'etc'
  // under the root — the agent would then refuse to attach and the user is
  // stuck with a phantom project at a path they didn't ask for.
  if (body.relativePath && body.relativePath.split(/[\\/]+/).some((part) => part === '..')) {
    return NextResponse.json({ error: 'relativePath must not contain ".." segments' }, { status: 400 });
  }

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
    // Audit: project creation can wire a custom spawnCommand that runs on
    // the agent, so the parameters matter for forensics. Record the full
    // shape (truncated by logAudit if needed).
    if (project) {
      logAudit({
        userId: user.id,
        action: 'create-project',
        subjectType: 'project',
        subjectId: project.id,
        deviceName: resolved.rootKey,
        request,
        payload: {
          name: project.name,
          relativePath: resolved.relativePath,
          agents: agents.map((agent) => ({
            agentType: agent.agentType,
            hasSpawnCommand: Boolean(agent.spawnCommand || agent.agentSpawnCommand)
          }))
        }
      });
    }
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json({ error: 'Project name already exists' }, { status: 409 });
    }
    throw error;
  }
});
