import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
import { forgetSshHostInBroker, probeRegisteredSshHost, refreshSshHostsForUser } from '@/lib/broker';

type Params = { params: Promise<{ hostId: string }> };

export const DELETE = withAuth(async (user, request: Request, { params }: Params) => {
  const { hostId } = await params;
  const existing = await prisma.sshHost.findFirst({
    where: { id: hostId, userId: user.id },
    select: { id: true, name: true, host: true, port: true, user: true }
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Order matters: DB delete FIRST, then in-memory cleanup. The previous
  // order (in-memory first, then DB delete) had a resurrection race —
  // any concurrent refreshSshHosts during the await would re-read the
  // still-present DB row and rebuild the in-memory record including a
  // fresh 30s pollHandle that leaked until the broker restarted. Doing
  // the DB delete first means any concurrent refresh sees the row gone
  // and prunes the in-memory entry instead of resurrecting it.
  await prisma.sshHost.delete({ where: { id: hostId } });
  forgetSshHostInBroker(user.id, hostId);

  logAudit({
    userId: user.id,
    action: 'revoke-token', // closest existing action; SSH host removal is functionally a device revoke
    subjectType: 'device',
    subjectId: hostId,
    deviceName: existing.name,
    request,
    payload: { kind: 'ssh', host: existing.host, port: existing.port, user: existing.user }
  });
  return NextResponse.json({ ok: true });
});

// Re-probe a single host. Used by the "Test connection" button in the UI.
export const POST = withAuth(async (user, _request: Request, { params }: Params) => {
  const { hostId } = await params;
  const existing = await prisma.sshHost.findFirst({
    where: { id: hostId, userId: user.id },
    select: { id: true }
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await refreshSshHostsForUser(user.id);
  const result = await probeRegisteredSshHost(user.id, hostId);
  return NextResponse.json(result);
});
