import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { mutateRuntime } from "@/lib/broker";
import { findTab, identityForTab } from "@/lib/runtime-projects";

type Params = { params: Promise<{ projectId: string; tabId: string }> };
const renameSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["tab", "pane"]).optional(),
});

export const PATCH = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = renameSchema.safeParse(body.data);
  const { project, tab } = await findTab(user.id, projectId, tabId);
  const identity = tab && identityForTab(tab);
  if (!parsed.success || !project || !tab || !identity) {
    return NextResponse.json(
      { error: project ? "Invalid tab payload" : "Not found" },
      { status: project ? 400 : 404 }
    );
  }
  const renamePane = parsed.data.scope === "pane" && identity.runtime === "herdr";
  try {
    await mutateRuntime(
      user.id,
      project.rootKey,
      renamePane ? "runtime.rename-pane" : "runtime.rename-tab",
      {
        runtime: identity.runtime,
        runtimeSessionId: identity.runtimeSessionId,
        tabId: identity.tabId,
        paneId: identity.paneId,
        name: parsed.data.name,
      }
    );
    return NextResponse.json({ pending: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not rename runtime tab" },
      { status: 400 }
    );
  }
});

export const DELETE = withAuth(async (user, request: Request, { params }: Params) => {
  const { projectId, tabId } = await params;
  const { project, tab } = await findTab(user.id, projectId, tabId);
  const identity = tab && identityForTab(tab);
  if (!project || !tab || !identity) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const runtimeTabs = new Set(project.tabs.map(item => item.runtimeTabId).filter(Boolean));
  const panesInTab = project.tabs.filter(item => item.runtimeTabId === tab.runtimeTabId);
  const closePane =
    new URL(request.url).searchParams.get("scope") === "pane" && panesInTab.length > 1;
  if (!closePane && runtimeTabs.size <= 1) {
    return NextResponse.json({ error: "Cannot delete the last tab in a space" }, { status: 409 });
  }
  try {
    await mutateRuntime(
      user.id,
      project.rootKey,
      closePane ? "runtime.close-pane" : "runtime.close-tab",
      {
        runtime: identity.runtime,
        runtimeSessionId: identity.runtimeSessionId,
        tabId: identity.tabId,
        paneId: identity.paneId,
      }
    );
    return NextResponse.json({ ok: true, pending: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not close runtime terminal" },
      { status: 400 }
    );
  }
});
