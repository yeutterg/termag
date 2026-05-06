import { prisma } from './prisma';
import { AGENT_DEFAULTS, agentSpawnCommand, normalizeRelativePath, tmuxName } from './defaults';

export async function listProjects(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    include: {
      tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } },
      sessions: true
    },
    orderBy: { openedAt: 'desc' }
  });
}

export async function createProject(input: {
  userId: string;
  name: string;
  rootKey: string;
  relativePath: string;
  agentType: string;
  agentSpawnCommand?: string;
}) {
  const project = await prisma.project.create({
    data: {
      userId: input.userId,
      name: input.name.trim(),
      rootKey: input.rootKey.trim(),
      relativePath: normalizeRelativePath(input.relativePath),
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
  const [last, project] = await Promise.all([
    prisma.tab.findFirst({ where: { projectId }, orderBy: { ordinal: 'desc' } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { agentType: true } })
  ]);
  const ordinal = (last?.ordinal ?? 0) + 1;
  const agentLabel = project ? AGENT_DEFAULTS[project.agentType as keyof typeof AGENT_DEFAULTS]?.label : undefined;
  const fallback = agentLabel ? (ordinal === 1 ? agentLabel : `${agentLabel} ${ordinal}`) : `Session ${ordinal}`;
  const tab = await prisma.tab.create({
    data: {
      projectId,
      name: name?.trim() || fallback,
      ordinal
    }
  });
  await prisma.session.create({
    data: {
      projectId,
      tabId: tab.id,
      kind: 'agent',
      tmuxName: tmuxName(projectId, tab.id)
    }
  });
  return prisma.tab.findUnique({ where: { id: tab.id }, include: { session: true } });
}

export async function touchProject(projectId: string) {
  return prisma.project.update({
    where: { id: projectId },
    data: { openedAt: new Date() }
  });
}
