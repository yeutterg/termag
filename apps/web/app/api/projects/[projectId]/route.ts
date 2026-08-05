import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { normalizeRelativePath, parseRoots } from "@/lib/defaults";
import { killTmuxProjectSessions, killTmuxWindows, mutateRuntime } from "@/lib/broker";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  rootKey: z.string().trim().min(1).optional(),
  relativePath: z.string().trim().min(1).optional(),
  agentSpawnCommand: z.string().trim().min(1).max(1000).optional(),
});

type Params = { params: Promise<{ projectId: string }> };

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId } = await params;
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const parsed = updateSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid project payload" }, { status: 400 });
  }
  const body = parsed.data;
  // Reject path traversal before normalization (see the matching guard in
  // POST /api/projects).
  if (body.relativePath && body.relativePath.split(/[\\/]+/).some(part => part === "..")) {
    return NextResponse.json(
      { error: 'relativePath must not contain ".." segments' },
      { status: 400 }
    );
  }
  if (body.rootKey && !parseRoots()[body.rootKey]) {
    const tokenRoot = await prisma.agentToken.findFirst({
      where: { userId: user.id, name: body.rootKey, revokedAt: null },
      select: { id: true },
    });
    if (!tokenRoot) {
      return NextResponse.json({ error: "Unknown device root" }, { status: 400 });
    }
  }
  const existing = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.mirrored) {
    if (!body.name || Object.keys(body).some(key => key !== "name")) {
      return NextResponse.json(
        { error: "Mirrored runtime workspaces only support renaming from this endpoint" },
        { status: 400 }
      );
    }
    try {
      await mutateRuntime(user.id, existing.rootKey, "runtime.rename-space", {
        runtime: existing.runtime,
        runtimeSessionId: existing.runtimeSessionId,
        spaceId: existing.externalId,
        name: body.name,
      });
      return NextResponse.json({
        ...existing,
        name: body.name,
        runtimeSpaceName: body.name,
        pending: true,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not rename runtime workspace" },
        { status: 400 }
      );
    }
  }
  const relativePath = body.relativePath ? normalizeRelativePath(body.relativePath) : undefined;
  if (body.relativePath && !relativePath) {
    return NextResponse.json({ error: "Project path is required" }, { status: 400 });
  }
  const data: z.infer<typeof updateSchema> = {};
  if (body.name !== undefined) {
    data.name = body.name;
  }
  if (body.rootKey !== undefined) {
    data.rootKey = body.rootKey;
  }
  if (relativePath !== undefined) {
    data.relativePath = relativePath;
  }
  if (body.agentSpawnCommand !== undefined) {
    data.agentSpawnCommand = body.agentSpawnCommand;
  }

  try {
    const project = await prisma.project.update({
      where: { id: projectId },
      data,
      include: {
        tabs: { orderBy: { ordinal: "asc" }, include: { session: true } },
        sessions: true,
      },
    });
    logAudit({
      userId: user.id,
      action: "update-project",
      subjectType: "project",
      subjectId: project.id,
      deviceName: project.rootKey,
      request,
      payload: { changed: Object.keys(data) },
    });
    return NextResponse.json(project);
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "Project name already exists" }, { status: 409 });
    }
    throw error;
  }
});

export const DELETE = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId } = await params;
  const existing = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: {
      id: true,
      name: true,
      rootKey: true,
      tmuxSessionName: true,
      tmuxManaged: true,
      runtime: true,
      runtimeSessionId: true,
      externalId: true,
      mirrored: true,
      sessions: { select: { tmuxName: true, tmuxManaged: true } },
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.mirrored && existing.runtimeSessionId) {
    try {
      await mutateRuntime(
        user.id,
        existing.rootKey,
        existing.runtime === "herdr" ? "runtime.close-space" : "runtime.close-session",
        {
          runtime: existing.runtime,
          runtimeSessionId: existing.runtimeSessionId,
          spaceId: existing.externalId,
        }
      );
      return NextResponse.json({ ok: true, pending: true }, { status: 202 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not close runtime workspace" },
        { status: 400 }
      );
    }
  }
  await prisma.project.delete({ where: { id: projectId } });
  if (existing.tmuxManaged !== false) {
    await killTmuxProjectSessions(user.id, [
      { rootKey: existing.rootKey, tmuxSessionName: existing.tmuxSessionName },
    ]);
  } else {
    await killTmuxWindows(
      user.id,
      existing.sessions
        .filter(session => session.tmuxManaged !== false)
        .map(session => ({ rootKey: existing.rootKey, tmuxName: session.tmuxName }))
    );
  }
  logAudit({
    userId: user.id,
    action: "delete-project",
    subjectType: "project",
    subjectId: existing.id,
    deviceName: existing.rootKey,
    request,
    payload: { name: existing.name, tmuxSessionName: existing.tmuxSessionName },
  });
  return NextResponse.json({ ok: true });
});
