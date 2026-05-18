import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createRawToken, hashToken, tokenPrefix } from '@/lib/tokens';
import { logAudit } from '@/lib/audit';

// Public endpoint — no auth, just the code. The code IS the credential
// for this one-shot exchange; we keep them short-TTL (15 min) and
// one-time-use to limit the blast radius if a link leaks.
//
// Atomic claim: we wrap the SELECT + UPDATE in a $transaction so two
// concurrent CLIs racing the same code can't both succeed. Whichever
// claim sets `consumedAt` first wins; the other gets 409.

type Params = { params: Promise<{ code: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { code } = await params;
  // Cheap reject for obvious garbage before any DB hop.
  if (!code || typeof code !== 'string' || code.length < 8 || code.length > 64) {
    return NextResponse.json({ error: 'Invalid bootstrap code' }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.bootstrapCode.findUnique({
        where: { code },
        select: { id: true, userId: true, deviceName: true, expiresAt: true, consumedAt: true, tokenId: true, code: true }
      });
      if (!row) return { kind: 'not-found' as const };
      if (row.consumedAt) return { kind: 'consumed' as const };
      if (row.expiresAt < new Date()) return { kind: 'expired' as const };

      const deviceName = row.deviceName || `device-${row.code.slice(0, 6)}`;
      // Mint the agent token + flip consumedAt atomically. If the token
      // create races against another device with the same `deviceName`,
      // P2002 surfaces and the transaction rolls back — the bootstrap
      // row stays unconsumed and the user can retry with a different name.
      const rawToken = createRawToken();
      const token = await tx.agentToken.create({
        data: {
          userId: row.userId,
          name: deviceName,
          tokenHash: hashToken(rawToken),
          tokenPrefix: tokenPrefix(rawToken)
        },
        select: { id: true, name: true }
      });
      await tx.bootstrapCode.update({
        where: { id: row.id },
        data: { consumedAt: new Date(), tokenId: token.id }
      });
      return { kind: 'ok' as const, userId: row.userId, deviceName: token.name, tokenId: token.id, rawToken };
    });

    if (result.kind === 'not-found') return NextResponse.json({ error: 'Bootstrap code not found' }, { status: 404 });
    if (result.kind === 'consumed') return NextResponse.json({ error: 'Bootstrap code already consumed' }, { status: 409 });
    if (result.kind === 'expired') return NextResponse.json({ error: 'Bootstrap code expired' }, { status: 410 });

    logAudit({
      userId: result.userId,
      action: 'create-token',
      subjectType: 'token',
      subjectId: result.tokenId,
      deviceName: result.deviceName,
      payload: { kind: 'bootstrap-claim' }
    });

    // Mirror what the Devices dialog returns so the CLI can write a
    // complete config.json from one response. roots is intentionally
    // left for the user to fill in — we don't know what directories
    // they want to expose on the new device yet.
    return NextResponse.json({
      url: deriveAgentUrl(_request),
      token: result.rawToken,
      deviceName: result.deviceName,
      hint: 'Set TERMAG_AGENT_ROOTS in ~/.termag/config.json (or via `termag config set roots …`).'
    }, { status: 200 });
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
      return NextResponse.json({ error: 'A device with that name already exists. Bootstrap code unspent — pick a different deviceName when you redeem.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Bootstrap claim failed' }, { status: 500 });
  }
}

function deriveAgentUrl(request: Request): string {
  // Browser-facing URL → WS endpoint. Prefer https→wss, fall back to ws.
  const proto = request.headers.get('x-forwarded-proto') || (request.url.startsWith('https') ? 'https' : 'http');
  const host = request.headers.get('host') || 'localhost:3000';
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  return `${wsProto}://${host}/api/ws/agent`;
}
