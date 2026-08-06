import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listProjects } from "@/lib/runtime-projects";
import { mutateRuntime } from "@/lib/broker";

const createSchema = z.object({
  name: z.string().trim().max(80).optional(),
  deviceName: z.string().trim().min(1).max(120),
  rootKey: z.string().trim().min(1).max(120),
  relativePath: z.string().trim().max(2048).default(""),
  runtime: z.enum(["herdr", "tmux"]),
  runtimeSessionId: z.string().trim().min(1).max(256).optional(),
});

function defaultName(relativePath: string) {
  return relativePath.split("/").filter(Boolean).at(-1) || "terminal";
}

export const GET = withAuth(async user => NextResponse.json(await listProjects(user.id)));

export const POST = withAuth(async (user, request: Request) => {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = createSchema.safeParse(body.data);
  if (!parsed.success || parsed.data.relativePath.split(/[\\/]+/).includes("..")) {
    return NextResponse.json({ error: "Invalid runtime creation payload" }, { status: 400 });
  }
  const input = parsed.data;
  const device = await prisma.agentToken.findFirst({
    where: { userId: user.id, name: input.deviceName, revokedAt: null, protocolVersion: 2 },
    select: { id: true },
  });
  if (!device) {
    return NextResponse.json({ error: "Protocol-v2 device is unavailable" }, { status: 409 });
  }
  if (input.runtime === "herdr" && !input.runtimeSessionId) {
    return NextResponse.json({ error: "Herdr session is required" }, { status: 400 });
  }
  const name = input.name || defaultName(input.relativePath);
  try {
    await mutateRuntime(
      user.id,
      input.deviceName,
      input.runtime === "herdr" ? "runtime.create-space" : "runtime.create-session",
      {
        runtime: input.runtime,
        runtimeSessionId: input.runtimeSessionId || name,
        name,
        rootKey: input.rootKey,
        relativePath: input.relativePath,
      }
    );
    return NextResponse.json({ pending: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Runtime creation failed" },
      { status: 400 }
    );
  }
});
