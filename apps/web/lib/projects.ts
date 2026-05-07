import { prisma } from './prisma';
import { agentLabel, agentSpawnCommand, normalizeRelativePath, tmuxName } from './defaults';

type ProjectAgent = {
  agentType?: string;
  label?: string;
  agentSpawnCommand?: string;
  spawnCommand?: string;
};

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function listProjects(userId: string) {
  // Manual order (position) wins; alphabetical (name asc) is the default
  // fallback for any project the user hasn't dragged yet.
  return prisma.project.findMany({
    where: { userId },
    include: {
      tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } },
      sessions: true
    },
    orderBy: [
      { position: { sort: 'asc', nulls: 'last' } },
      { name: 'asc' }
    ]
  });
}

/**
 * Persist a user's drag-reordered list. Assigns evenly spaced positions so
 * later inserts can land between two without renumbering everything.
 */
export async function reorderProjects(userId: string, projectIds: string[]) {
  const ownProjects = await prisma.project.findMany({
    where: { userId },
    select: { id: true }
  });
  const ownIds = new Set(ownProjects.map((p) => p.id));
  if (projectIds.length !== ownIds.size || !projectIds.every((id) => ownIds.has(id))) {
    throw new Error('reorderProjects: id list must cover exactly the user’s own projects');
  }
  await prisma.$transaction(
    projectIds.map((id, idx) =>
      prisma.project.update({
        where: { id },
        data: { position: (idx + 1) * 1000 }
      })
    )
  );
}

export async function createProject(input: {
  userId: string;
  name: string;
  rootKey: string;
  relativePath: string;
  agentType?: string;
  agentSpawnCommand?: string;
  agents?: ProjectAgent[];
}) {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath) throw new Error('Project path is required');
  const agents = input.agents?.length
    ? input.agents
    : [{ agentType: input.agentType ?? 'codex', agentSpawnCommand: input.agentSpawnCommand }];
  const primaryAgent = normalizeAgent(agents[0]);

  const project = await prisma.project.create({
    data: {
      userId: input.userId,
      name: input.name.trim(),
      rootKey: input.rootKey.trim(),
      relativePath,
      agentType: primaryAgent.agentType,
      agentSpawnCommand: primaryAgent.spawnCommand
    }
  });

  // Default tab name = the coding agent's display name (Claude Code, Codex, custom command).
  // The user can rename later, and live xterm titles from the running tool
  // override this for display.
  for (const agent of agents) {
    const resolvedAgent = normalizeAgent(agent);
    await createTab(project.id, {
      name: resolvedAgent.label,
      agentType: resolvedAgent.agentType,
      spawnCommand: resolvedAgent.spawnCommand
    });
  }
  await ensureCtrlSession(project.id);
  return prisma.project.findUnique({
    where: { id: project.id },
    include: { tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } }, sessions: true }
  });
}

export async function ensureCtrlSession(projectId: string) {
  const existing = await prisma.session.findFirst({ where: { projectId, kind: 'ctrl' } });
  if (existing) return existing;
  return prisma.session.create({
    data: {
      projectId,
      kind: 'ctrl',
      tmuxName: tmuxName(projectId, 'ctrl')
    }
  });
}

export async function createTab(projectId: string, options: { name?: string; agentType?: string; spawnCommand?: string } | string = {}) {
  const tabOptions = typeof options === 'string' ? { name: options } : options;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const last = await tx.tab.findFirst({ where: { projectId }, orderBy: { ordinal: 'desc' } });
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { agentType: true, agentSpawnCommand: true } });
        const ordinal = (last?.ordinal ?? 0) + 1;
        const selectedAgentType = tabOptions.agentType ?? project?.agentType ?? 'codex';
        const selectedSpawnCommand = tabOptions.spawnCommand ?? project?.agentSpawnCommand ?? agentSpawnCommand(selectedAgentType);
        const selectedLabel = agentLabel(selectedAgentType) ?? labelFromCommand(selectedSpawnCommand);
        const fallback = selectedLabel ? (ordinal === 1 ? selectedLabel : `${selectedLabel} ${ordinal}`) : `Session ${ordinal}`;
        const tab = await tx.tab.create({
          data: {
            projectId,
            name: tabOptions.name?.trim() || fallback,
            ordinal
          }
        });
        await tx.session.create({
          data: {
            projectId,
            tabId: tab.id,
            kind: 'agent',
            tmuxName: tmuxName(projectId, tab.id),
            agentType: selectedAgentType,
            spawnCommand: selectedSpawnCommand
          }
        });
        return tx.tab.findUnique({ where: { id: tab.id }, include: { session: true } });
      });
    } catch (error) {
      if (attempt < 2 && isUniqueConstraintError(error)) continue;
      throw error;
    }
  }
  throw new Error('Unable to create tab');
}

function normalizeAgent(agent: ProjectAgent) {
  const agentType = (agent.agentType || 'custom').trim();
  const spawnCommand = (agent.spawnCommand || agent.agentSpawnCommand || '').trim() || agentSpawnCommand(agentType);
  return {
    agentType,
    spawnCommand,
    label: agent.label?.trim() || agentLabel(agentType) || labelFromCommand(spawnCommand)
  };
}

function labelFromCommand(command: string) {
  const executable = command.trim().split(/\s+/)[0]?.split('/').filter(Boolean).at(-1);
  if (!executable) return 'Custom agent';
  return executable
    .replace(/\.(js|ts|mjs|cjs|sh|bash|zsh)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
