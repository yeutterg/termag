import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { SshAttachShell } from './shell';

// Server component: validates the SshHost belongs to the requesting user
// before we surface anything client-side. The WS upgrade re-validates with
// the same userId scoping, so even a hand-crafted URL can't reach hosts
// the requester doesn't own — this page-level check just avoids rendering
// a doomed terminal that would 1008-close on connect.

export default async function SshAttachPage({
  params
}: {
  params: Promise<{ hostId: string; sessionName: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  const { hostId, sessionName } = await params;
  const host = await prisma.sshHost.findFirst({
    where: { id: hostId, userId: user.id },
    select: { id: true, name: true, host: true, user: true, port: true }
  });
  if (!host) {
    redirect('/');
  }
  return (
    <SshAttachShell
      hostId={host.id}
      hostLabel={`${host.user}@${host.host}${host.port !== 22 ? `:${host.port}` : ''}`}
      hostName={host.name}
      sessionName={sessionName}
    />
  );
}
