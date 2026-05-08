import { prisma } from './prisma';
import { agentLabel, agentSpawnCommand, normalizeRelativePath, tmuxSessionName, tmuxWindowName } from './defaults';

type ProjectAgent = {
  agentType?: string;
  label?: string;
  agentSpawnCommand?: string;
  spawnCommand?: string;
};

export type AttachedTmuxWindow = {
  name: string;
  target: string;
  windowName?: string;
  ordinal?: number;
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
      tmuxManaged: true,
      agentType: primaryAgent.agentType,
      agentSpawnCommand: primaryAgent.spawnCommand
    }
  });
  const projectTmuxSessionName = tmuxSessionName(project.id);
  await prisma.project.update({
    where: { id: project.id },
    data: { tmuxSessionName: projectTmuxSessionName }
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
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { tmuxSessionName: true, tmuxManaged: true }
  });
  const windowName = tmuxWindowName('ctrl');
  return prisma.session.create({
    data: {
      projectId,
      kind: 'ctrl',
      tmuxName: `${project?.tmuxSessionName || tmuxSessionName(projectId)}:${windowName}`,
      tmuxWindowName: windowName,
      tmuxManaged: project?.tmuxManaged ?? true
    }
  });
}

export async function createTab(projectId: string, options: { name?: string; agentType?: string; spawnCommand?: string } | string = {}) {
  const tabOptions = typeof options === 'string' ? { name: options } : options;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const last = await tx.tab.findFirst({ where: { projectId }, orderBy: { ordinal: 'desc' } });
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { agentType: true, agentSpawnCommand: true, tmuxSessionName: true, tmuxManaged: true }
        });
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
        const windowName = tmuxWindowName(tab.id);
        await tx.session.create({
          data: {
            projectId,
            tabId: tab.id,
            kind: 'agent',
            tmuxName: `${project?.tmuxSessionName || tmuxSessionName(projectId)}:${windowName}`,
            tmuxWindowName: windowName,
            tmuxManaged: true,
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

export async function createAttachedTmuxProject(input: {
  userId: string;
  rootKey: string;
  sessionName: string;
  path?: string;
  windows: AttachedTmuxWindow[];
}) {
  const windows = input.windows.filter((window) => window.target.trim());
  if (windows.length === 0) throw new Error('No tmux windows to attach');
  const name = await uniqueProjectName(input.userId, input.sessionName.trim() || 'tmux session');
  const relativePath = normalizeRelativePath(input.path || input.sessionName) || normalizeRelativePath(input.sessionName) || 'tmux-session';

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        userId: input.userId,
        name,
        rootKey: input.rootKey.trim(),
        relativePath,
        tmuxSessionName: input.sessionName.trim(),
        tmuxManaged: false,
        agentType: 'tmux',
        agentSpawnCommand: '$SHELL'
      }
    });

    for (const [index, window] of windows.entries()) {
      const ordinal = window.ordinal && window.ordinal > 0 ? window.ordinal : index + 1;
      const tab = await tx.tab.create({
        data: {
          projectId: project.id,
          name: window.name.trim() || `Window ${ordinal}`,
          ordinal
        }
      });
      await tx.session.create({
        data: {
          projectId: project.id,
          tabId: tab.id,
          kind: 'agent',
          tmuxName: window.target.trim(),
          tmuxWindowName: window.windowName?.trim() || window.name.trim() || String(ordinal),
          tmuxManaged: false,
          agentType: 'tmux'
        }
      });
    }

    return tx.project.findUnique({
      where: { id: project.id },
      include: { tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } }, sessions: true }
    });
  });
}

export async function publishTmuxProject(input: {
  userId: string;
  rootKey: string;
  projectName: string;
  sessionName: string;
  path?: string;
  windows: AttachedTmuxWindow[];
}) {
  const windows = input.windows.filter((window) => window.target.trim());
  if (windows.length === 0) throw new Error('No tmux windows to publish');
  const projectName = input.projectName.trim();
  const sessionName = input.sessionName.trim();
  if (!projectName || !sessionName) throw new Error('Project and tmux session are required');

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: {
        userId: input.userId,
        OR: [
          { name: projectName },
          { rootKey: input.rootKey, tmuxSessionName: sessionName }
        ]
      },
      include: { tabs: { orderBy: { ordinal: 'desc' }, take: 1 } }
    });

    if (project && project.tmuxSessionName && project.tmuxSessionName !== sessionName) {
      throw new Error(`Project "${project.name}" is already bound to tmux session "${project.tmuxSessionName}"`);
    }

    const relativePath = normalizeRelativePath(input.path || sessionName) || normalizeRelativePath(sessionName) || 'tmux-session';
    const targetProject = project ?? await tx.project.create({
      data: {
        userId: input.userId,
        name: projectName,
        rootKey: input.rootKey.trim(),
        relativePath,
        tmuxSessionName: sessionName,
        tmuxManaged: false,
        agentType: 'tmux',
        agentSpawnCommand: '$SHELL'
      },
      include: { tabs: { orderBy: { ordinal: 'desc' }, take: 1 } }
    });

    let nextOrdinal = (targetProject.tabs[0]?.ordinal ?? 0) + 1;
    for (const window of windows) {
      const tmuxName = window.target.trim();
      const existing = await tx.session.findFirst({
        where: {
          projectId: targetProject.id,
          OR: [
            { tmuxName },
            { tmuxWindowName: tmuxName }
          ]
        },
        include: { tab: true }
      });
      if (existing) {
        const nextName = window.name.trim();
        if (nextName && existing.tab && existing.tab.name !== nextName) {
          await tx.tab.update({ where: { id: existing.tab.id }, data: { name: nextName } });
        }
        continue;
      }

      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      const tab = await tx.tab.create({
        data: {
          projectId: targetProject.id,
          name: window.name.trim() || `Window ${window.ordinal ?? ordinal}`,
          ordinal
        }
      });
      await tx.session.create({
        data: {
          projectId: targetProject.id,
          tabId: tab.id,
          kind: 'agent',
          tmuxName,
          tmuxWindowName: window.windowName?.trim() || window.name.trim() || String(window.ordinal ?? ordinal),
          tmuxManaged: false,
          agentType: 'tmux'
        }
      });
    }

    return tx.project.findUnique({
      where: { id: targetProject.id },
      include: { tabs: { orderBy: { ordinal: 'asc' }, include: { session: true } }, sessions: true }
    });
  });
}

async function uniqueProjectName(userId: string, preferred: string) {
  const base = preferred.trim() || 'tmux session';
  const existing = await prisma.project.findMany({
    where: { userId, OR: [{ name: base }, { name: { startsWith: `${base} ` } }] },
    select: { name: true }
  });
  const names = new Set(existing.map((project) => project.name));
  if (!names.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
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
