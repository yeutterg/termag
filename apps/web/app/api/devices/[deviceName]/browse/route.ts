import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { listDeviceDirectory } from '@/lib/broker';

export const GET = withAuth(
  async (user, request: Request, { params }: { params: Promise<{ deviceName: string }> }) => {
    const { deviceName } = await params;
    const decodedDevice = decodeURIComponent(deviceName);
    const url = new URL(request.url);
    const rootKey = url.searchParams.get('rootKey') || '';
    const relativePath = url.searchParams.get('relativePath') || '';

    const token = await prisma.agentToken.findFirst({
      where: { userId: user.id, name: decodedDevice, revokedAt: null },
      select: { id: true }
    });
    if (!token) {
      return NextResponse.json({ error: 'Unknown device' }, { status: 404 });
    }

    try {
      const listing = await listDeviceDirectory(user.id, decodedDevice, rootKey, relativePath);
      return NextResponse.json(listing);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not list directory';
      const status = /offline/i.test(message) ? 503 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  }
);
