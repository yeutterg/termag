import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PASSWORD_COOKIE, checkPassword, passwordCookieValue, passwordGateEnabled } from '@/lib/auth';

const schema = z.object({ password: z.string().min(1).max(256) });

export async function POST(request: Request) {
  if (!passwordGateEnabled()) {
    return NextResponse.json({ error: 'Password mode not enabled' }, { status: 400 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  if (!checkPassword(parsed.data.password)) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(PASSWORD_COOKIE, passwordCookieValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(PASSWORD_COOKIE);
  return response;
}
