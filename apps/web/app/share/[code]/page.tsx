import { prisma } from '@/lib/prisma';
import { ShareAttachShell } from './shell';

// Public share page — anyone with the code reaches this without auth.
// The page itself fetches the link metadata for rendering the header.
// The actual stream uses /api/ws/share-terminal?code= which re-validates
// the code on every connect.

export const dynamic = 'force-dynamic';

export default async function SharePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const row = await prisma.shareLink.findUnique({
    where: { code },
    select: { code: true, expiresAt: true, revokedAt: true, tmuxName: true, sshHostId: true }
  });
  // Resolve host name in a follow-up query — ShareLink doesn't currently
  // declare a Prisma relation to SshHost (the FK is stored manually).
  const host = row?.sshHostId
    ? await prisma.sshHost.findUnique({ where: { id: row.sshHostId }, select: { name: true } })
    : null;
  if (!row || row.revokedAt || row.expiresAt < new Date() || !row.tmuxName) {
    return (
      <div className="grid h-screen place-items-center bg-bg px-4 text-center text-text">
        <div>
          <div className="mb-2 text-lg font-semibold">Share link unavailable</div>
          <div className="text-sm text-muted">This link has expired, been revoked, or never existed. Ask the owner for a fresh one.</div>
        </div>
      </div>
    );
  }
  return (
    <ShareAttachShell
      code={row.code}
      hostName={host?.name || 'unknown host'}
      sessionName={row.tmuxName}
      expiresAt={row.expiresAt.toISOString()}
    />
  );
}
