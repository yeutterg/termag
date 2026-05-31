import { prisma } from "./prisma";
import type { Tab } from "./session-manager";

/**
 * Get the current active session for a project from Prisma
 */
export async function getActiveSessionForProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      sessions: {
        where: { isActive: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!project || !project.sessions[0]) {
    return null;
  }
  return project.sessions[0];
}

/**
 * Get all sessions for a project from Prisma
 */
export async function getProjectSessions(projectId: string) {
  return prisma.session.findMany({
    where: {
      tab: {
        projectId,
      },
    },
    include: {
      tab: {
        include: {
          project: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Create a new session in Prisma and return its ID
 */
export async function createSessionInPrisma(
  projectId: string,
  name: string = "New Session"
): Promise<{ sessionId: string; tmuxSessionName: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      sessions: true,
    },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  // Create a new tab
  const tab = await prisma.tab.create({
    data: {
      projectId,
      name,
      ordinal: project.sessions.length + 1,
    },
  });

  // Create a session for the tab
  const session = await prisma.session.create({
    data: {
      tabId: tab.id,
      isActive: true,
      agentType: project.agentType || "codex",
    },
  });

  // Generate tmux session name following termag convention
  const tmuxSessionName = `termag-${projectId}-${tab.id}`;

  return {
    sessionId: session.id,
    tmuxSessionName,
  };
}

/**
 * Activate a session (set it as active)
 */
export async function activateSession(sessionId: string) {
  // Deactivate all sessions in the same project
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      tab: {
        include: {
          project: true,
        },
      },
    },
  });

  if (!session) {
    throw new Error("Session not found");
  }

  await prisma.session.updateMany({
    where: {
      tab: {
        projectId: session.tab.projectId,
      },
    },
    data: {
      isActive: false,
    },
  });

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      isActive: true,
    },
  });
}

/**
 * Close a session (delete it or mark as inactive)
 */
export async function closeSession(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      isActive: false,
    },
  });
}

/**
 * Get session info for file explorer context
 */
export async function getSessionWorkingDirectory(sessionId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      tab: {
        include: {
          project: true,
        },
      },
    },
  });

  if (!session) {
    return null;
  }

  // The working directory is the project's rootKey + relativePath
  const project = session.tab.project;
  // This would need to be resolved to an actual path
  // For now, return the relativePath
  return project.relativePath || null;
}

/**
 * Convert Prisma sessions to Tab format for session-manager compatibility
 */
export async function prismaSessionsToTabs(projectId: string): Promise<Tab[]> {
  const sessions = await getProjectSessions(projectId);

  return sessions.map(session => ({
    id: session.id,
    name: session.tab.name,
    projectId: session.tab.projectId,
    sessionId: session.id,
    isActive: session.isActive,
    isPinned: false, // Could add a pinned field to Session model
  }));
}
