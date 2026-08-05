import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { killTmuxProjectSessions, refreshUserProjects } from "@/lib/broker";
import { prisma } from "@/lib/prisma";

const activeSchema = z.object({
  mode: z.literal("active"),
  rootKey: z.string().trim().min(1),
  tmuxSessionName: z.string().trim().min(1),
});

const missingSchema = z.object({
  mode: z.literal("missing"),
  rootKey: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  tabId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
});

const cleanupSchema = z.discriminatedUnion("mode", [activeSchema, missingSchema]);

export const POST = withAuth(async (user, request: Request) => {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const parsed = cleanupSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid tmux cleanup payload" }, { status: 400 });
  }

  if (parsed.data.mode === "active") {
    const { rootKey, tmuxSessionName } = parsed.data;
    const projects = await prisma.project.findMany({
      where: { userId: user.id, rootKey, tmuxSessionName },
      select: { id: true },
    });
    const projectIds = projects.map(project => project.id);
    const projectExclusion = projectIds.length > 0 ? { id: { notIn: projectIds } } : {};
    const sessions = await prisma.session.findMany({
      where: {
        project: { userId: user.id, rootKey, ...projectExclusion },
        OR: [{ tmuxName: tmuxSessionName }, { tmuxName: { startsWith: `${tmuxSessionName}:` } }],
      },
      select: { id: true, projectId: true, tabId: true },
    });

    await killTmuxProjectSessions(user.id, [{ rootKey, tmuxSessionName }]);
    if (projectIds.length > 0) {
      await prisma.project.deleteMany({ where: { userId: user.id, id: { in: projectIds } } });
    }
    await deleteSessionRecords(sessions);

    refreshUserProjects(user.id);
    return NextResponse.json({
      ok: true,
      deletedProjects: projects.length,
      deletedSessions: sessions.length,
    });
  }

  const { rootKey, projectId, tabId, sessionId } = parsed.data;
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id, rootKey },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (tabId) {
    const [tab, tabCount] = await Promise.all([
      prisma.tab.findFirst({ where: { id: tabId, projectId }, select: { id: true } }),
      prisma.tab.count({ where: { projectId } }),
    ]);
    if (!tab) {
      return NextResponse.json({ error: "Tab not found" }, { status: 404 });
    }

    if (tabCount <= 1) {
      await prisma.project.delete({ where: { id: projectId } });
    } else {
      await prisma.tab.delete({ where: { id: tabId } });
      await updateProjectStatus(projectId);
    }
    refreshUserProjects(user.id);
    return NextResponse.json({ ok: true });
  }

  if (sessionId) {
    const session = await prisma.session.findFirst({
      where: { id: sessionId, projectId },
      select: { id: true, tabId: true },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.tabId) {
      const tabCount = await prisma.tab.count({ where: { projectId } });
      if (tabCount <= 1) {
        await prisma.project.delete({ where: { id: projectId } });
      } else {
        await prisma.tab.delete({ where: { id: session.tabId } });
        await updateProjectStatus(projectId);
      }
    } else {
      await prisma.session.delete({ where: { id: sessionId } });
      await updateProjectStatus(projectId);
    }
    refreshUserProjects(user.id);
    return NextResponse.json({ ok: true });
  }

  await prisma.project.delete({ where: { id: projectId } });
  refreshUserProjects(user.id);
  return NextResponse.json({ ok: true });
});

async function updateProjectStatus(projectId: string) {
  const sessions = await prisma.session.findMany({
    where: { projectId },
    select: { status: true },
  });
  const statuses = sessions.map(session => session.status);
  const status =
    ["error", "waiting", "working", "idle"].find(candidate => statuses.includes(candidate)) ||
    "sleeping";
  await prisma.project.update({ where: { id: projectId }, data: { status } }).catch(() => {});
}

async function deleteSessionRecords(
  sessions: Array<{ id: string; projectId: string | null; tabId: string | null }>
) {
  // SSH-anchored sessions have projectId null; cleanup goes through the
  // SshHost delete path, not here. Skip them so we don't try to group
  // them under a non-existent project.
  const projectSessions = sessions.filter(
    (session): session is { id: string; projectId: string; tabId: string | null } =>
      session.projectId !== null
  );
  const byProject = new Map<string, Array<{ id: string; tabId: string | null }>>();
  for (const session of projectSessions) {
    byProject.set(session.projectId, [
      ...(byProject.get(session.projectId) ?? []),
      { id: session.id, tabId: session.tabId },
    ]);
  }

  for (const [projectId, projectSessions] of byProject) {
    const tabIds = [
      ...new Set(
        projectSessions
          .map(session => session.tabId)
          .filter((tabId): tabId is string => Boolean(tabId))
      ),
    ];
    const sessionIds = projectSessions.filter(session => !session.tabId).map(session => session.id);
    const tabCount = await prisma.tab.count({ where: { projectId } });

    if (tabIds.length > 0 && tabIds.length >= tabCount) {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
      continue;
    }

    if (tabIds.length > 0) {
      await prisma.tab.deleteMany({ where: { id: { in: tabIds }, projectId } });
    }
    if (sessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: sessionIds }, projectId } });
    }
    await updateProjectStatus(projectId);
  }
}
