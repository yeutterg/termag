import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJsonBody, withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
import { probeRegisteredSshHost, refreshSshHostsForUser } from '@/lib/broker';

// Schema for "name": same shape as device labels elsewhere. Hostname is
// permissive (allow DNS dots, IPv6 brackets, slashes-in-host? No, ssh uses
// host[:port]) — we just block shell metacharacters in the probe path.
// Color accepts either a hex like "#ef4444" or empty/null for "no color".
// Tailwind palette tokens like "red" / "amber" / "green" / etc. would be
// passed through; UI maps known names to its theme variables.
const colorSchema = z.string().trim().max(20).regex(/^(#[0-9A-Fa-f]{6}|[a-z]{3,12})?$/).nullish();

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._:\[\]-]+$/, 'hostname has invalid characters'),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'ssh user has invalid characters'),
  color: colorSchema
});

const publicView = {
  id: true,
  name: true,
  host: true,
  port: true,
  user: true,
  lastSeenAt: true,
  lastError: true,
  color: true,
  createdAt: true
} as const;

export const GET = withAuth(async (user) => {
  const hosts = await prisma.sshHost.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    select: publicView
  });
  return NextResponse.json(hosts);
});

export const POST = withAuth(async (user, request: Request) => {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = createSchema.safeParse(bodyResult.data);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message || 'Invalid SSH host payload' }, { status: 400 });
  }
  const body = parsed.data;

  // Name uniqueness also blocks collisions with agent token names: an agent
  // device and an ssh device with the same display name would be confusing
  // (which one shows up in `termag list`?). Check both tables in one go.
  const collision = await prisma.$transaction(async (tx) => {
    const existingSsh = await tx.sshHost.findFirst({
      where: { userId: user.id, name: body.name },
      select: { id: true }
    });
    if (existingSsh) return 'ssh' as const;
    const existingAgent = await tx.agentToken.findFirst({
      where: { userId: user.id, name: body.name, revokedAt: null },
      select: { id: true }
    });
    if (existingAgent) return 'agent' as const;
    return null;
  });
  if (collision) {
    return NextResponse.json(
      { error: `A ${collision === 'ssh' ? 'SSH host' : 'device'} named "${body.name}" already exists` },
      { status: 409 }
    );
  }

  const host = await prisma.sshHost.create({
    data: {
      userId: user.id,
      name: body.name,
      host: body.host,
      port: body.port ?? 22,
      user: body.user,
      color: body.color || null
    },
    select: publicView
  });

  // Audit before triggering the probe — that way even if probing OOMs the
  // process the record of "this host was added at this time by this IP" is
  // already on disk.
  logAudit({
    userId: user.id,
    action: 'create-token', // reusing the closest existing action for now
    subjectType: 'device',
    subjectId: host.id,
    deviceName: host.name,
    request,
    payload: { kind: 'ssh', host: host.host, port: host.port, user: host.user }
  });

  // Kick off an async probe so the UI can show fresh status without the user
  // waiting on the create call. The broker's poller will also pick it up on
  // the next 30s tick, but immediate probing makes "Add host" feel
  // responsive.
  refreshSshHostsForUser(user.id).catch(() => {});
  probeRegisteredSshHost(user.id, host.id).catch(() => {});

  return NextResponse.json(host, { status: 201 });
});
