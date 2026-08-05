import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { publishTmuxProject } from "@/lib/projects";
import { refreshUserProjects, requestAgentHealthRefresh } from "@/lib/broker";
import { hashToken } from "@/lib/tokens";
import { clientIpFromRequest, createRateLimiter } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/auth";

// Rate-limit bad-token attempts. Without this, an attacker can hammer
// publish with a guessed bearer per request — each one costs a SHA-256 +
// indexed DB lookup, and timing differences could potentially leak token
// validity. 60 attempts / 5 min per IP is generous for legitimate agents
// (which rarely retry-storm) and tight against enumeration.
const limiter = createRateLimiter({
  perIpWindowMs: 5 * 60 * 1000,
  perIpBurst: 60,
  perIpLockoutMs: 10 * 60 * 1000,
  globalWindowMs: 60 * 1000,
  globalBurst: 300,
});

const windowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  target: z.string().trim().min(1).max(240),
  windowName: z.string().trim().min(1).max(120).optional(),
  ordinal: z.number().int().min(0).max(10000).optional(),
});

const publishSchema = z.object({
  projectName: z.string().trim().min(1).max(80),
  tmuxSessionName: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(1000).optional(),
  windows: z.array(windowSchema).min(1).max(100),
});

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || "";
}

export async function POST(request: Request) {
  // Cheap rejects first: shape + length checks before any DB work, so a
  // probing attacker can't burn DB cycles by sending malformed tokens.
  const rawToken = bearerToken(request);
  if (!rawToken || rawToken.length < 32 || rawToken.length > 256 || !rawToken.startsWith("tmag_")) {
    return NextResponse.json({ error: "Missing or malformed agent token" }, { status: 401 });
  }

  const ip = clientIpFromRequest(request);
  const limit = limiter.check(ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const token = await prisma.agentToken.findFirst({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    select: { id: true, userId: true, name: true },
  });
  if (!token) {
    limiter.record(ip, false);
    return NextResponse.json({ error: "Invalid agent token" }, { status: 401 });
  }
  limiter.record(ip, true);

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const parsed = publishSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid tmux publish payload" }, { status: 400 });
  }

  await prisma.agentToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date() },
  });

  try {
    const project = await publishTmuxProject({
      userId: token.userId,
      rootKey: token.name || "Local device",
      projectName: parsed.data.projectName,
      sessionName: parsed.data.tmuxSessionName,
      path: parsed.data.path,
      windows: parsed.data.windows,
    });
    refreshUserProjects(token.userId);
    // Tell the device's persistent agent to send a fresh health ping right
    // away — without this, the UI's missing-target detection has up to
    // HEALTH_INTERVAL_MS of stale tmuxSessions data after each publish and
    // can flag freshly-published tabs as missing.
    requestAgentHealthRefresh(token.userId, token.name || "Local device");
    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not publish tmux session";
    const status = message.includes("already bound") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
