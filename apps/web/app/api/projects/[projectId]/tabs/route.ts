import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createTab } from "@/lib/projects";
import { mutateRuntime } from "@/lib/broker";

export const POST = withAuth(
  async (user, _request: Request, { params }: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await params;
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (project.mirrored && project.runtimeSessionId && project.externalId) {
      try {
        await mutateRuntime(user.id, project.rootKey, "runtime.create-tab", {
          runtime: project.runtime,
          runtimeSessionId: project.runtimeSessionId,
          spaceId: project.externalId,
          name: "terminal",
          relativePath: project.creationPath || "",
        });
        return NextResponse.json({ pending: true }, { status: 202 });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Could not create runtime tab" },
          { status: 400 }
        );
      }
    }
    const tab = await createTab(project.id);
    return NextResponse.json(tab, { status: 201 });
  }
);
