import { prisma } from './prisma';
import { AGENT_DEFAULTS, agentSpawnCommand, normalizeRelativePath, tmuxName } from './defaults';

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
  agentType: string;
  agentSpawnCommand?: string;
}) {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath) throw new Error('Project path is required');

  const project = await prisma.project.create({
    data: {
      userId: input.userId,
      name: input.name.trim(),
      rootKey: input.rootKey.trim(),
      relativePath,
      agentType: input.agentType,
      agentSpawnCommand: input.agentSpawnCommand?.trim() || agentSpawnCommand(input.agentType)
    }
  });

  // Default tab name = the coding agent's display name (Claude Code, Codex).
  // The user can rename later, and live xterm titles from the running tool
  // override this for display.
  await createTab(project.id, AGENT_DEFAULTS[input.agentType as keyof typeof AGENT_DEFAULTS]?.label);
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

export async function createTab(projectId: string, name?: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const last = await tx.tab.findFirst({ where: { projectId }, orderBy: { ordinal: 'desc' } });
        const project = await tx.project.findUnique({ where: { id: projectId }, select: { agentType: true } });
        const ordinal = (last?.ordinal ?? 0) + 1;
        const agentLabel = project ? AGENT_DEFAULTS[project.agentType as keyof typeof AGENT_DEFAULTS]?.label : undefined;
        const fallback = agentLabel ? (ordinal === 1 ? agentLabel : `${agentLabel} ${ordinal}`) : `Session ${ordinal}`;
        const tab = await tx.tab.create({
          data: {
            projectId,
            name: name?.trim() || fallback,
            ordinal
          }
        });
        await tx.session.create({
          data: {
            projectId,
            tabId: tab.id,
            kind: 'agent',
            tmuxName: tmuxName(projectId, tab.id)
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
