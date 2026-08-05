import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { createRawToken, hashToken, tokenPrefix } from "@/lib/tokens";

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Explicit select to keep tokenHash off the wire.
const tokenView = {
  id: true,
  name: true,
  tokenPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  defaultRootKey: true,
  defaultRelativePath: true,
} as const;

export const GET = withAuth(async user => {
  const tokens = await prisma.agentToken.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: tokenView,
  });
  return NextResponse.json(tokens);
});

export const POST = withAuth(async (user, request: Request) => {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const parsed = createSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid token payload" }, { status: 400 });
  }
  const existing = await prisma.agentToken.findFirst({
    where: { userId: user.id, name: parsed.data.name, revokedAt: null },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A device with that name already has an active token" },
      { status: 409 }
    );
  }
  const raw = createRawToken();
  const token = await prisma.agentToken.create({
    data: {
      userId: user.id,
      name: parsed.data.name,
      tokenHash: hashToken(raw),
      tokenPrefix: tokenPrefix(raw),
    },
    select: tokenView,
  });
  // Token creation is a high-trust event: this token is full access to the
  // user's account for whichever device gets it. Record name + prefix so a
  // future audit can match the token back to its row without revealing it.
  logAudit({
    userId: user.id,
    action: "create-token",
    subjectType: "token",
    subjectId: token.id,
    deviceName: token.name,
    request,
    payload: { name: token.name, prefix: token.tokenPrefix },
  });
  return NextResponse.json({ ...token, token: raw }, { status: 201 });
});
