import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, readJsonBody } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  acquirePowerLeaseOnDevice,
  getCaffeinateStatusOnDevice,
  releasePowerLeaseOnDevice,
} from "@/lib/broker";

const actionSchema = z.object({
  action: z.enum(["acquire", "renew", "release"]),
  leaseId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:_-]+$/),
  mode: z.enum(["terminals-awake", "display-awake", "ac-awake"]).default("terminals-awake"),
  durationMs: z
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60 * 1000)
    .default(120_000),
});

async function knownDevice(userId: string, deviceName: string) {
  return prisma.agentToken.findFirst({
    where: { userId, name: deviceName, revokedAt: null },
    select: { id: true },
  });
}

export const GET = withAuth(
  async (user, _request: Request, { params }: { params: Promise<{ deviceName: string }> }) => {
    const { deviceName } = await params;
    if (!(await knownDevice(user.id, deviceName))) {
      return NextResponse.json({ error: "Unknown device" }, { status: 404 });
    }
    try {
      return NextResponse.json(await getCaffeinateStatusOnDevice(user.id, deviceName));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read power state";
      return NextResponse.json(
        { error: message },
        { status: /offline/i.test(message) ? 503 : 400 }
      );
    }
  }
);

export const POST = withAuth(
  async (user, request: Request, { params }: { params: Promise<{ deviceName: string }> }) => {
    const { deviceName } = await params;
    if (!(await knownDevice(user.id, deviceName))) {
      return NextResponse.json({ error: "Unknown device" }, { status: 404 });
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const parsed = actionSchema.safeParse(body.data);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid power lease request" }, { status: 400 });
    }
    try {
      const { action, leaseId, mode, durationMs } = parsed.data;
      // Scope browser-generated IDs at the authenticated boundary so one
      // account cannot renew or release another account's assertion.
      const scopedLeaseId = `web:${createHash("sha256")
        .update(user.id)
        .update("\0")
        .update(leaseId)
        .digest("base64url")}`;
      const result =
        action === "release"
          ? await releasePowerLeaseOnDevice(user.id, deviceName, scopedLeaseId)
          : await acquirePowerLeaseOnDevice(
              user.id,
              deviceName,
              scopedLeaseId,
              mode,
              "Remote terminal lease",
              durationMs,
              action === "renew"
            );
      return NextResponse.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Power operation failed";
      return NextResponse.json(
        { error: message },
        { status: /offline/i.test(message) ? 503 : 400 }
      );
    }
  }
);
