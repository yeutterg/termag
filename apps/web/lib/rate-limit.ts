/**
 * Shared in-memory rate limiter. Single-process broker so this is enough;
 * a multi-instance deployment needs to move state to Redis. Each call site
 * creates its own bucket store via createRateLimiter() so limits stay
 * isolated (a brute force on /api/auth/password can't lock out
 * /api/tmux/publish or vice versa).
 *
 * IP identification policy is the same as the audit log: trust XFF /
 * X-Real-IP only when TERMAG_TRUSTED_PROXY=true. Otherwise everyone shares
 * the "unknown" bucket and only the global ceiling applies.
 */

export type RateLimitConfig = {
  perIpWindowMs: number;
  perIpBurst: number;
  perIpLockoutMs: number;
  globalWindowMs: number;
  globalBurst: number;
  bucketsCap?: number;
  sweepIntervalMs?: number;
};

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

type IpBucket = { count: number; windowStart: number; lockedUntil: number };

export function createRateLimiter(config: RateLimitConfig) {
  const ipBuckets = new Map<string, IpBucket>();
  let globalCount = 0;
  let globalWindowStart = Date.now();
  let lastSweepAt = Date.now();
  const bucketsCap = config.bucketsCap ?? 10_000;
  const sweepIntervalMs = config.sweepIntervalMs ?? 5 * 60 * 1000;

  function maybeSweep(now: number) {
    if (now - lastSweepAt < sweepIntervalMs && ipBuckets.size < bucketsCap) return;
    lastSweepAt = now;
    for (const [ip, bucket] of ipBuckets) {
      const expired = bucket.lockedUntil <= now && now - bucket.windowStart > config.perIpWindowMs;
      if (expired) ipBuckets.delete(ip);
    }
    if (ipBuckets.size > bucketsCap) {
      const entries = [...ipBuckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      for (let i = 0; i < entries.length - bucketsCap; i++) {
        ipBuckets.delete(entries[i][0]);
      }
    }
  }

  function check(ip: string): RateLimitResult {
    const now = Date.now();
    maybeSweep(now);
    if (now - globalWindowStart > config.globalWindowMs) {
      globalCount = 0;
      globalWindowStart = now;
    }
    if (globalCount >= config.globalBurst) {
      const retryAfterMs = config.globalWindowMs - (now - globalWindowStart);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    if (ip === 'unknown') return { ok: true };
    let bucket = ipBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > config.perIpWindowMs) {
      bucket = { count: 0, windowStart: now, lockedUntil: 0 };
      ipBuckets.set(ip, bucket);
    }
    if (bucket.lockedUntil > now) {
      return { ok: false, retryAfterSec: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    if (bucket.count >= config.perIpBurst) {
      bucket.lockedUntil = now + config.perIpLockoutMs;
      return { ok: false, retryAfterSec: Math.ceil(config.perIpLockoutMs / 1000) };
    }
    return { ok: true };
  }

  function record(ip: string, success: boolean) {
    globalCount += 1;
    if (ip === 'unknown') return;
    const bucket = ipBuckets.get(ip);
    if (!bucket) return;
    if (success) {
      ipBuckets.delete(ip);
    } else {
      bucket.count += 1;
    }
  }

  return { check, record };
}

/**
 * Identifies the client by IP. Only honors X-Forwarded-For / X-Real-IP when
 * TERMAG_TRUSTED_PROXY=true. Without that flag, trusting these headers
 * lets a direct attacker spoof a fresh IP per request to defeat the
 * per-IP limit. Returns "unknown" otherwise — paired with the limiter's
 * "skip per-IP when unknown" rule, so legitimate non-proxy callers aren't
 * sharing one global bucket that locks everyone out.
 */
export function clientIpFromRequest(request: Request): string {
  if (process.env.TERMAG_TRUSTED_PROXY !== 'true') return 'unknown';
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim().slice(0, 64);
  return request.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}
