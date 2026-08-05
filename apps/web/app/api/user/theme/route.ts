import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({ theme: z.enum(["system", "light", "dark"]) });

export const PATCH = withAuth(async (user, request: Request) => {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid theme payload" }, { status: 400 });
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { theme: parsed.data.theme },
  });
  return NextResponse.json({ theme: updated.theme });
});
