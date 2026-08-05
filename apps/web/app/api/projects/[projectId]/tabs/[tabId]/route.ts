import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { killTmuxWindows, mutateRuntime, renameTmuxWindow } from "@/lib/broker";

type Params = { params: Promise<{ projectId: string; tabId: string }> };

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["tab", "pane"]).optional(),
});

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = updateSchema.safeParse(bodyResult.data);
  if (!parsed.success) return NextResponse.json({ error: "Invalid tab payload" }, { status: 400 });
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } },
    include: {
      session: { select: { id: true, tmuxName: true, tmuxManaged: true } },
      project: {
        select: {
          rootKey: true,
          runtime: true,
          runtimeSessionId: true,
          mirrored: true,
        },
      },
    },
  });
  if (!tab) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tab.project.mirrored && tab.project.runtimeSessionId && tab.runtimeTabId) {
    const renamePane =
      parsed.data.scope === "pane" && tab.project.runtime === "herdr" && tab.runtimePaneId;
    try {
      await mutateRuntime(
        user.id,
        tab.project.rootKey,
        renamePane ? "runtime.rename-pane" : "runtime.rename-tab",
        {
          runtime: tab.project.runtime,
          runtimeSessionId: tab.project.runtimeSessionId,
          tabId: tab.runtimeTabId,
          paneId: tab.runtimePaneId,
          name: parsed.data.name.trim(),
        }
      );
      return NextResponse.json({ ...tab, name: parsed.data.name.trim(), pending: true });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not rename runtime tab" },
        { status: 400 }
      );
    }
  }
  let tmuxUpdate: { tmuxName?: string; tmuxWindowName?: string } | null = null;
  if (tab.session && tab.session.tmuxManaged !== false) {
    tmuxUpdate = await renameTmuxWindow(user.id, {
      rootKey: tab.project.rootKey,
      tmuxName: tab.session?.tmuxName,
      name: parsed.data.name.trim(),
    });
  }
  const sessionUpdate =
    tab.session && tab.session.tmuxManaged !== false
      ? {
          update: {
            tmuxName: tmuxUpdate?.tmuxName ?? tab.session.tmuxName,
            tmuxWindowName: tmuxUpdate?.tmuxWindowName || parsed.data.name.trim(),
          },
        }
      : undefined;
  const updated = await prisma.tab.update({
    where: { id: tab.id },
    data: {
      name: parsed.data.name.trim(),
      session: sessionUpdate,
    },
    include: { session: true },
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const tab = await prisma.tab.findFirst({
    where: { id: tabId, project: { id: projectId, userId: user.id } },
    include: {
      session: { select: { tmuxName: true, tmuxManaged: true } },
      project: {
        select: {
          rootKey: true,
          runtime: true,
          runtimeSessionId: true,
          mirrored: true,
        },
      },
    },
  });
  if (!tab) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tab.project.mirrored && tab.project.runtimeSessionId && tab.runtimeTabId) {
    const paneCount = await prisma.tab.count({
      where: {
        projectId,
        runtimeTabId: tab.runtimeTabId,
        archivedAt: null,
      },
    });
    const scope = new URL(request.url).searchParams.get("scope");
    const closePane = scope === "pane" && paneCount > 1;
    if (!closePane) {
      const runtimeTabs = await prisma.tab.findMany({
        where: { projectId, archivedAt: null },
        select: { runtimeTabId: true },
      });
      if (new Set(runtimeTabs.map(item => item.runtimeTabId).filter(Boolean)).size <= 1) {
        return NextResponse.json(
          { error: "Cannot delete the last tab in a project" },
          { status: 409 }
        );
      }
    }
    const operation = closePane ? "runtime.close-pane" : "runtime.close-tab";
    const payload = {
      runtime: tab.project.runtime,
      runtimeSessionId: tab.project.runtimeSessionId,
      tabId: tab.runtimeTabId,
      paneId: tab.runtimePaneId,
    };
    try {
      await mutateRuntime(user.id, tab.project.rootKey, operation, payload);
      return NextResponse.json({ ok: true, pending: true }, { status: 202 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not close runtime terminal" },
        { status: 400 }
      );
    }
  }
  const activeTabCount = await prisma.tab.count({ where: { projectId, archivedAt: null } });
  if (activeTabCount <= 1) {
    return NextResponse.json({ error: "Cannot delete the last tab in a project" }, { status: 409 });
  }
  await prisma.tab.delete({ where: { id: tab.id } });
  if (tab.session?.tmuxManaged !== false) {
    await killTmuxWindows(user.id, [
      { rootKey: tab.project.rootKey, tmuxName: tab.session?.tmuxName },
    ]);
  }
  return NextResponse.json({ ok: true });
});
