import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { disconnectAgentToken } from "@/lib/broker";

const tokenView = {
  id: true,
  name: true,
  tokenPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  defaultRootKey: true,
  defaultRelativePath: true,
} as const;

const patchSchema = z.object({
  defaultRootKey: z.union([z.string().trim().min(1).max(120), z.null()]).optional(),
  defaultRelativePath: z.union([z.string().trim().max(512), z.null()]).optional(),
});

function normalizeRelative(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (/[\x00-\x1F\x7F]/.test(value) || value.split(/[\\/]+/).some(part => part === "..")) {
    throw new Error("Default path must stay inside the device root");
  }
  const cleaned = value
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(part => part && part !== "." && part !== "..")
    .join("/");
  return cleaned;
}

export const DELETE = withAuth(
  async (user, request: Request, { params }: { params: Promise<{ tokenId: string }> }) => {
    const { tokenId } = await params;
    const existing = await prisma.agentToken.findFirst({ where: { id: tokenId, userId: user.id } });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await prisma.agentToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date(), activeName: null },
    });
    disconnectAgentToken(user.id, tokenId);
    return NextResponse.json({ ok: true });
  }
);

export const PATCH = withAuth(
  async (user, request: Request, { params }: { params: Promise<{ tokenId: string }> }) => {
    const { tokenId } = await params;
    const existing = await prisma.agentToken.findFirst({ where: { id: tokenId, userId: user.id } });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const parsed = patchSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid token payload" }, { status: 400 });
    }
    const data: { defaultRootKey?: string | null; defaultRelativePath?: string | null } = {};
    if ("defaultRootKey" in parsed.data) {
      data.defaultRootKey = parsed.data.defaultRootKey ?? null;
    }
    if ("defaultRelativePath" in parsed.data) {
      try {
        data.defaultRelativePath = normalizeRelative(parsed.data.defaultRelativePath ?? null);
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Invalid default path" },
          { status: 400 }
        );
      }
    }
    const updated = await prisma.agentToken.update({
      where: { id: tokenId },
      data,
      select: tokenView,
    });
    return NextResponse.json(updated);
  }
);
