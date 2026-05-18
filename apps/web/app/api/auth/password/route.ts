import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PASSWORD_COOKIE, checkPassword, isOriginSafe, passwordCookieValue, passwordGateEnabled } from '@/lib/auth';
import { logAudit } from '@/lib/audit';

const schema = z.object({ password: z.string().min(1).max(256) });

/**
 * In-memory token-bucket rate limiter for the password gate. Single-process
 * broker so this is enough; if termag ever runs multi-instance the limiter
 * needs to move to Redis (or to the reverse proxy). Two layers:
 *   - per-IP bucket: 5 attempts / 5 min, slowing thereafter
 *   - global ceiling: 30 attempts / minute, regardless of IP — protects
 *     against distributed brute force when the attacker rotates IPs
 *
 * On lockout we return 429 with Retry-After so curl/scripts back off.
 */
const PER_IP_WINDOW_MS = 5 * 60 * 1000;
const PER_IP_BURST = 5;
const PER_IP_LOCKOUT_MS = 30 * 60 * 1000;
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_BURST = 30;

type IpBucket = { count: number; windowStart: number; lockedUntil: number };
const ipBuckets = new Map<string, IpBucket>();
let globalCount = 0;
let globalWindowStart = Date.now();

function clientIp(request: Request): string {
  // Trust X-Forwarded-For only if the deployment sits behind a known proxy
  // — but we don't have a config for that yet, so use it as the best-effort
  // identifier and fall back to a static bucket otherwise. The static
  // fallback means the global limit still protects us when IPs are unknown.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function checkRateLimit(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();

  // Global limiter first — cheaper, catches the distributed case.
  if (now - globalWindowStart > GLOBAL_WINDOW_MS) {
    globalCount = 0;
    globalWindowStart = now;
  }
  if (globalCount >= GLOBAL_BURST) {
    const retryAfterMs = GLOBAL_WINDOW_MS - (now - globalWindowStart);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  // Per-IP bucket. Lockout is the long tail after exhausting the burst.
  let bucket = ipBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > PER_IP_WINDOW_MS) {
    bucket = { count: 0, windowStart: now, lockedUntil: 0 };
    ipBuckets.set(ip, bucket);
  }
  if (bucket.lockedUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.lockedUntil - now) / 1000) };
  }
  if (bucket.count >= PER_IP_BURST) {
    bucket.lockedUntil = now + PER_IP_LOCKOUT_MS;
    return { ok: false, retryAfterSec: Math.ceil(PER_IP_LOCKOUT_MS / 1000) };
  }
  return { ok: true };
}

function recordAttempt(ip: string, success: boolean) {
  globalCount += 1;
  const bucket = ipBuckets.get(ip);
  if (!bucket) return;
  if (success) {
    ipBuckets.delete(ip); // reset on success — don't punish a typo
  } else {
    bucket.count += 1;
  }
}

export async function POST(request: Request) {
  if (!passwordGateEnabled()) {
    return NextResponse.json({ error: 'Password mode not enabled' }, { status: 400 });
  }
  if (!isOriginSafe(request)) {
    return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
  }

  const ip = clientIp(request);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    recordAttempt(ip, false);
    logAudit({ action: 'password-failure', request, payload: { reason: 'invalid-payload' } });
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  if (!checkPassword(parsed.data.password)) {
    recordAttempt(ip, false);
    logAudit({ action: 'password-failure', request, payload: { reason: 'wrong-password' } });
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }
  recordAttempt(ip, true);
  logAudit({ action: 'password-success', request });

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

export async function DELETE(request: Request) {
  if (!isOriginSafe(request)) {
    return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PASSWORD_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0
  });
  return response;
}
