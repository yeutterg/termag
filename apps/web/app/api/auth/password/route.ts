import { NextResponse } from "next/server";
import { z } from "zod";
import {
  PASSWORD_COOKIE,
  checkPassword,
  isOriginSafe,
  passwordCookieValue,
  passwordGateEnabled,
  readJsonBody,
} from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { clientIpFromRequest, createRateLimiter } from "@/lib/rate-limit";

const schema = z.object({ password: z.string().min(1).max(256) });

// 5 attempts per 5 min per IP, then 30-minute lockout. Global ceiling
// 30/min stops distributed brute force when the attacker rotates IPs.
const limiter = createRateLimiter({
  perIpWindowMs: 5 * 60 * 1000,
  perIpBurst: 5,
  perIpLockoutMs: 30 * 60 * 1000,
  globalWindowMs: 60 * 1000,
  globalBurst: 30,
});

export async function POST(request: Request) {
  if (!passwordGateEnabled()) {
    return NextResponse.json({ error: "Password mode not enabled" }, { status: 400 });
  }
  if (!isOriginSafe(request)) {
    return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
  }

  const ip = clientIpFromRequest(request);
  const limit = limiter.check(ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    limiter.record(ip, false);
    logAudit({ action: "password-failure", request, payload: { reason: "invalid-payload" } });
    return bodyResult.response;
  }
  const parsed = schema.safeParse(bodyResult.data);
  if (!parsed.success) {
    limiter.record(ip, false);
    logAudit({ action: "password-failure", request, payload: { reason: "invalid-payload" } });
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (!checkPassword(parsed.data.password)) {
    limiter.record(ip, false);
    logAudit({ action: "password-failure", request, payload: { reason: "wrong-password" } });
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  limiter.record(ip, true);
  logAudit({ action: "password-success", request });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(PASSWORD_COOKIE, passwordCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}

export async function DELETE(request: Request) {
  if (!isOriginSafe(request)) {
    return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PASSWORD_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
