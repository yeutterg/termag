import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';

// Bootstrap codes are short (~12 chars), use a URL-safe alphabet, and
// have meaningful entropy (~70 bits). They live for 15 minutes; after
// that the row is ignored even if not explicitly revoked. One-time use:
// the first successful claim sets consumedAt; subsequent claims fail.

const BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
const BOOTSTRAP_CODE_BYTES = 9; // 9 random bytes → 12 base64url chars

function generateCode(): string {
  return crypto.randomBytes(BOOTSTRAP_CODE_BYTES).toString('base64url');
}

const startSchema = z.object({
  deviceName: z.string().trim().min(1).max(80).optional()
});

export const POST = withAuth(async (user, request: Request) => {
  const parsed = startSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + BOOTSTRAP_TTL_MS);
  const row = await prisma.bootstrapCode.create({
    data: {
      userId: user.id,
      code,
      deviceName: parsed.data.deviceName || null,
      expiresAt
    },
    select: { code: true, expiresAt: true }
  });

  // Build the absolute URL the new device's CLI will hit. We prefer the
  // request's Host header so dev (localhost) and prod (custom domain)
  // both work without a separate config knob.
  const proto = request.headers.get('x-forwarded-proto') || 'http';
  const host = request.headers.get('host') || 'localhost:3000';
  const claimUrl = `${proto}://${host}/api/bootstrap/claim/${row.code}`;

  logAudit({
    userId: user.id,
    action: 'create-token', // closest existing variant; will become "issue-bootstrap" once the enum expands
    subjectType: 'token',
    deviceName: parsed.data.deviceName ?? null,
    request,
    payload: { kind: 'bootstrap-code', expiresAt: row.expiresAt.toISOString() }
  });

  return NextResponse.json({
    code: row.code,
    claimUrl,
    expiresAt: row.expiresAt.toISOString(),
    cliCommand: `termag bootstrap ${claimUrl}`
  });
});
