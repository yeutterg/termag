import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';

// Read-only share link for an SSH session. The owner of the host mints
// a code (default 30 min TTL); anyone with the link can attach to that
// host's tmux session in read-only mode. Use cases: peer over my
// shoulder while debugging, share a build log, etc.
//
// SECURITY: the code IS the credential here. Treat it like a password
// (TTL'd, single-purpose, audit-logged on use). No support for agent
// flow in v1 — only SSH.

const DEFAULT_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 24 * 60; // 24h ceiling
const CODE_BYTES = 12;

const createSchema = z.object({
  sshHostId: z.string().trim().min(1),
  tmuxName: z.string().trim().min(1).max(120),
  ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional()
});

export const POST = withAuth(async (user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  // Verify host ownership before minting a code that targets it.
  const host = await prisma.sshHost.findFirst({
    where: { id: parsed.data.sshHostId, userId: user.id },
    select: { id: true, name: true }
  });
  if (!host) return NextResponse.json({ error: 'SSH host not found' }, { status: 404 });

  const code = crypto.randomBytes(CODE_BYTES).toString('base64url');
  const ttlMs = (parsed.data.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const row = await prisma.shareLink.create({
    data: {
      userId: user.id,
      code,
      sshHostId: host.id,
      tmuxName: parsed.data.tmuxName,
      expiresAt
    },
    select: { code: true, expiresAt: true }
  });

  const proto = request.headers.get('x-forwarded-proto') || 'http';
  const reqHost = request.headers.get('host') || 'localhost:3000';
  const shareUrl = `${proto}://${reqHost}/share/${row.code}`;

  logAudit({
    userId: user.id,
    action: 'attach', // closest fit; "share-link-minted" can be added later
    subjectType: 'device',
    deviceName: host.name,
    request,
    payload: { kind: 'share-link', tmuxName: parsed.data.tmuxName, expiresAt: row.expiresAt.toISOString() }
  });

  return NextResponse.json({ code: row.code, url: shareUrl, expiresAt: row.expiresAt.toISOString() });
});

export const GET = withAuth(async (user) => {
  const rows = await prisma.shareLink.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, code: true, sshHostId: true, tmuxName: true, expiresAt: true, useCount: true, lastUsedAt: true, createdAt: true }
  });
  return NextResponse.json(rows);
});
