import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody, withAuth } from "@/lib/auth";
import { runGitOperation } from "@/lib/broker";
import { findProject } from "@/lib/runtime-projects";

const projectId = z.string().trim().min(1).max(4096);
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are not allowed");
const relativeGitPath = singleLine(4096).refine(
  value =>
    value === "." ||
    (!value.startsWith("/") &&
      !value.startsWith(":") &&
      !value.split(/[\\/]+/).some(segment => segment === "..")),
  "Git paths must be relative and cannot contain '..' or pathspec magic"
);

const schema = z.discriminatedUnion("operation", [
  z.object({ projectId, operation: z.literal("git.status") }).strict(),
  z.object({ projectId, operation: z.literal("git.branch"), branch: singleLine(240) }).strict(),
  z.object({ projectId, operation: z.literal("git.commit"), message: singleLine(4096) }).strict(),
  z.object({ projectId, operation: z.literal("git.push") }).strict(),
  z.object({ projectId, operation: z.literal("git.pull") }).strict(),
  z
    .object({
      projectId,
      operation: z.literal("git.stage"),
      paths: z.array(relativeGitPath).min(1).max(100),
    })
    .strict(),
]);

export const POST = withAuth(async (user, request: Request) => {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid git operation" }, { status: 400 });
  }
  const { projectId: selectedProjectId, operation } = parsed.data;
  const project = await findProject(user.id, selectedProjectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!project.directoryRootKey) {
    return NextResponse.json(
      { error: "This terminal directory is outside the device's configured roots" },
      { status: 409 }
    );
  }

  const operationPayload =
    operation === "git.branch"
      ? { branch: parsed.data.branch }
      : operation === "git.commit"
        ? { message: parsed.data.message }
        : operation === "git.stage"
          ? { paths: parsed.data.paths }
          : {};
  try {
    const result = await runGitOperation(user.id, project.rootKey, operation, {
      ...operationPayload,
      rootKey: project.directoryRootKey,
      relativePath: project.relativePath,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git operation failed";
    const status = message.includes("offline") ? 503 : message.includes("timed out") ? 504 : 400;
    return NextResponse.json({ error: message }, { status });
  }
});
