import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { mutateRuntime, type RuntimeOperation } from "@/lib/broker";

const operations = [
  "runtime.create-session",
  "runtime.create-space",
  "runtime.create-tab",
  "runtime.rename-space",
  "runtime.rename-tab",
  "runtime.close-tab",
  "runtime.close-pane",
  "runtime.close-space",
  "runtime.close-session",
] as const;

const schema = z.object({
  deviceName: z.string().trim().min(1).max(120),
  operation: z.enum(operations),
  payload: z.record(z.unknown()).default({}),
});

export const POST = withAuth(async (user, request: Request) => {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid runtime operation" }, { status: 400 });
  }
  try {
    const result = await mutateRuntime(
      user.id,
      parsed.data.deviceName,
      parsed.data.operation as RuntimeOperation,
      parsed.data.payload
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Runtime operation failed";
    return NextResponse.json(
      { error: message },
      { status: message.includes("offline") ? 503 : 400 }
    );
  }
});
