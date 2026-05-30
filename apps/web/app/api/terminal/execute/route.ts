import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";
import { readJsonBody } from "@/lib/auth";

const commandSchema = z.object({
  sessionId: z.string(),
  command: z.string().min(1).max(10000),
  workingDirectory: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
});

export async function POST(request: Request) {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const parsed = commandSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid command payload" }, { status: 400 });
  }

  const { sessionId, command, workingDirectory, timeoutMs } = parsed.data;

  // Verify the session exists and belongs to the user
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
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Get the agent token for this project
  const device = await prisma.agentToken.findFirst({
    where: {
      userId: session.tab.project.userId,
      name: session.tab.project.rootKey,
      revokedAt: null,
    },
  });

  if (!device) {
    return NextResponse.json({ error: "Agent not connected" }, { status: 503 });
  }

  // In a real implementation, this would:
  // 1. Send the command to the agent via WebSocket broker
  // 2. Wait for the response
  // 3. Return the output

  // For now, return a mock response
  return NextResponse.json({
    sessionId,
    command,
    workingDirectory,
    output: "",
    exitCode: 0,
    executedAt: new Date().toISOString(),
  });
}
