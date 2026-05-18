import { prisma } from './prisma';

// Audit events: append-only record of security-relevant actions. Writes are
// fire-and-forget — an audit failure should never block the underlying
// action. If the DB is unavailable we lose the event rather than the user
// operation.
//
// Payload is a small JSON object describing the action. Keep it < ~1KB:
// don't dump full session output or large diffs. The point is forensics,
// not full replay.

export type AuditAction =
  | 'attach'
  | 'kill-session'
  | 'kill-window'
  | 'rename-window'
  | 'create-project'
  | 'update-project'
  | 'delete-project'
  | 'reorder-projects'
  | 'create-tab'
  | 'update-tab'
  | 'delete-tab'
  | 'create-token'
  | 'update-token'
  | 'revoke-token'
  | 'password-success'
  | 'password-failure'
  | 'login-success'
  | 'logout';

export type AuditInput = {
  userId?: string | null;
  action: AuditAction;
  subjectType?: 'session' | 'project' | 'tab' | 'token' | 'device' | null;
  subjectId?: string | null;
  deviceName?: string | null;
  request?: Request;
  payload?: Record<string, unknown> | null;
};

export function extractAuditContext(request: Request | undefined | null): { ip: string | null; userAgent: string | null } {
  if (!request) return { ip: null, userAgent: null };
  const xff = request.headers.get('x-forwarded-for');
  const ip = (xff ? xff.split(',')[0]!.trim() : request.headers.get('x-real-ip')?.trim()) || null;
  const userAgent = request.headers.get('user-agent') || null;
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
      payloadJson = raw.length > 4096 ? raw.slice(0, 4093) + '...' : raw;
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
        userId: input.userId ?? null
      }
    })
    .catch((err) => {
      // Last-resort log to stderr — the audit infra itself is broken if we
      // reach here, and silent failure would mean missing events forever.
      console.error('[audit] write failed:', err instanceof Error ? err.message : String(err));
    });
}
