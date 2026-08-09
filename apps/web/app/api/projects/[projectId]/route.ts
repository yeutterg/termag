import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { mutateRuntime } from "@/lib/broker";
import { findProject, identityForProject } from "@/lib/runtime-projects";

const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });
type Params = { params: Promise<{ projectId: string }> };

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId } = await params;
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = renameSchema.safeParse(body.data);
  const project = await findProject(user.id, projectId);
  const identity = project && identityForProject(project);
  if (!parsed.success || !project || !identity) {
    return NextResponse.json(
      { error: project ? "Invalid name" : "Not found" },
      { status: project ? 400 : 404 }
    );
  }
  try {
    await mutateRuntime(user.id, project.rootKey, "runtime.rename-space", {
      runtime: identity.runtime,
      runtimeSessionId: identity.runtimeSessionId,
      spaceId: identity.spaceId,
      name: parsed.data.name,
    });
    return NextResponse.json({ pending: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not rename runtime workspace" },
      { status: 400 }
    );
  }
});

export const DELETE = withAuth(async (user, _request: Request, { params }: Params) => {
  const { projectId } = await params;
  const project = await findProject(user.id, projectId);
  const identity = project && identityForProject(project);
  if (!project || !identity) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    await mutateRuntime(
      user.id,
      project.rootKey,
      identity.runtime === "herdr" ? "runtime.close-space" : "runtime.close-session",
      {
        runtime: identity.runtime,
        runtimeSessionId: identity.runtimeSessionId,
        spaceId: identity.spaceId,
      }
    );
    return NextResponse.json({ ok: true, pending: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not close runtime workspace" },
      { status: 400 }
    );
  }
});
