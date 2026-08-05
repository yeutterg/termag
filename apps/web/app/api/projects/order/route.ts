import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { reorderProjects } from "@/lib/projects";

const schema = z.object({ projectIds: z.array(z.string().min(1)).min(1) });

export const PATCH = withAuth(async (user, request: Request) => {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid order payload" }, { status: 400 });
  }
  try {
    await reorderProjects(user.id, parsed.data.projectIds);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reorder failed" },
      { status: 400 }
    );
  }
});
