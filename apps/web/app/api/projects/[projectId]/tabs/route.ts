import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { mutateRuntime } from "@/lib/broker";
import { findProject, identityForProject } from "@/lib/runtime-projects";

export const POST = withAuth(
  async (user, _request: Request, { params }: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await params;
    const project = await findProject(user.id, projectId);
    const identity = project && identityForProject(project);
    if (!project || !identity) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!project.directoryRootKey) {
      return NextResponse.json(
        { error: "This terminal is outside the machine's creation roots" },
        { status: 409 }
      );
    }
    try {
      await mutateRuntime(user.id, project.rootKey, "runtime.create-tab", {
        runtime: identity.runtime,
        runtimeSessionId: identity.runtimeSessionId,
        spaceId: identity.spaceId,
        name: "terminal",
        rootKey: project.directoryRootKey,
        relativePath: project.relativePath,
      });
      return NextResponse.json({ pending: true }, { status: 202 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not create runtime tab" },
        { status: 400 }
      );
    }
  }
);
