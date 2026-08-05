import { prisma } from "./prisma";

// Audit events: append-only record of security-relevant actions. Writes are
// fire-and-forget — an audit failure should never block the underlying
// action. If the DB is unavailable we lose the event rather than the user
// operation.
//
// Payload is a small JSON object describing the action. Keep it < ~1KB:
// don't dump full session output or large diffs. The point is forensics,
// not full replay.

export type AuditAction =
  | "attach"
  | "kill-session"
  | "kill-window"
  | "rename-window"
  | "create-project"
  | "update-project"
  | "delete-project"
  | "reorder-projects"
  | "create-tab"
  | "update-tab"
  | "delete-tab"
  | "git-operation"
  | "create-token"
  | "update-token"
  | "revoke-token"
  | "password-success"
  | "password-failure"
  | "login-success"
  | "logout";

export type AuditInput = {
  userId?: string | null;
  action: AuditAction;
  subjectType?: "session" | "project" | "tab" | "token" | "device" | null;
  subjectId?: string | null;
  deviceName?: string | null;
  request?: Request;
  payload?: Record<string, unknown> | null;
};

export function extractAuditContext(request: Request | undefined | null): {
  ip: string | null;
  userAgent: string | null;
} {
  if (!request) {
    return { ip: null, userAgent: null };
  }
  // Trust XFF/X-Real-IP only when explicitly told we're behind a known
  // proxy. Otherwise these headers are attacker-controlled — recording
  // them as "the IP" would let an attacker pollute audit logs with
  // arbitrary attribution. See clientIp() in /api/auth/password/route.ts
  // for the matching policy on the rate limiter.
  let ip: string | null = null;
  if (process.env.TERMAG_TRUSTED_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      ip = xff.split(",")[0]!.trim().slice(0, 64);
    } else {
      ip = request.headers.get("x-real-ip")?.trim().slice(0, 64) || null;
    }
  }
  // Cap User-Agent so a 4KB-UA client can't bloat audit rows. Node's HTTP
  // parser caps total headers at ~8KB, but a single header can still be
  // huge.
  const rawUa = request.headers.get("user-agent");
  const userAgent = rawUa ? rawUa.slice(0, 512) : null;
  return { ip, userAgent };
}

export function logAudit(input: AuditInput): void {
  const { ip, userAgent } = extractAuditContext(input.request);
  // Truncate payload JSON to a safe ceiling so a runaway caller can't bloat
  // the audit table with one giant event.
  let payloadJson: string | null = null;
  if (input.payload) {
    try {
      const raw = JSON.stringify(input.payload);
      payloadJson = raw.length > 4096 ? raw.slice(0, 4093) + "..." : raw;
    } catch {
      payloadJson = null;
    }
  }
  prisma.auditEvent
    .create({
      data: {
        action: input.action,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        deviceName: input.deviceName ?? null,
        ip,
        userAgent,
        payload: payloadJson,
        userId: input.userId ?? null,
      },
    })
    .catch(err => {
      // Last-resort log to stderr — the audit infra itself is broken if we
      // reach here, and silent failure would mean missing events forever.
      console.error("[audit] write failed:", err instanceof Error ? err.message : String(err));
    });
}
