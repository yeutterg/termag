import { NextResponse } from "next/server";

// Simple in-memory rate limiter for development
// This single-instance broker keeps a bounded in-process limiter.
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// Sweeping the whole map on every request is O(entries) on the hot path once
// buckets are per-identity rather than one shared key. Expire the accessed
// key eagerly and sweep the rest at most this often.
const SWEEP_INTERVAL_MS = 10_000;
// Bounds memory if an attacker rotates identities to mint fresh buckets. The
// global ceiling below is what actually limits them; this just caps the map.
const MAX_TRACKED_IDENTITIES = 20_000;

class RateLimiter {
  private requests: Map<string, RateLimitEntry> = new Map();
  private globalCount = 0;
  private globalResetTime = 0;
  private lastSweep = 0;

  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 60000,
    // Ceiling across every identity combined. Per-identity buckets are the
    // useful limit; this exists so that rotating identities still cannot
    // drive unbounded work.
    private globalMaxRequests: number = maxRequests * 50
  ) {}

  /** Public accessor for the per-identity ceiling (used in 429 headers). */
  get limit(): number {
    return this.maxRequests;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS && this.requests.size < MAX_TRACKED_IDENTITIES) {
      return;
    }
    this.lastSweep = now;
    for (const [key, entry] of this.requests.entries()) {
      if (entry.resetTime <= now) {
        this.requests.delete(key);
      }
    }
    // Still oversized after expiry: drop the oldest insertions. Map iteration
    // order is insertion order.
    if (this.requests.size > MAX_TRACKED_IDENTITIES) {
      const excess = this.requests.size - MAX_TRACKED_IDENTITIES;
      let dropped = 0;
      for (const key of this.requests.keys()) {
        this.requests.delete(key);
        if (++dropped >= excess) {
          break;
        }
      }
    }
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    this.sweep(now);

    if (this.globalResetTime <= now) {
      this.globalCount = 0;
      this.globalResetTime = now + this.windowMs;
    }
    if (this.globalCount >= this.globalMaxRequests) {
      return { allowed: false, remaining: 0, resetTime: this.globalResetTime };
    }
    this.globalCount += 1;

    const entry = this.requests.get(identifier);

    if (!entry || entry.resetTime <= now) {
      // First request or window expired
      const newEntry: RateLimitEntry = {
        count: 1,
        resetTime: now + this.windowMs,
      };
      this.requests.set(identifier, newEntry);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: newEntry.resetTime,
      };
    }

    if (entry.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
      };
    }

    entry.count++;
    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetTime: entry.resetTime,
    };
  }

  reset(identifier: string) {
    this.requests.delete(identifier);
  }

  destroy() {
    this.requests.clear();
    this.globalCount = 0;
    this.globalResetTime = 0;
  }
}

export function clientIpFromRequest(request: Request): string {
  // Forwarded IP headers are attacker-controlled unless the deployment has
  // explicitly declared its reverse proxy trusted.
  if (process.env.TERMINALZ_TRUSTED_PROXY !== "true") {
    return "direct";
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwarded ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "proxy-unknown"
  ).slice(0, 64);
}

// Auth.js writes one of these depending on version and whether the cookie is
// issued over HTTPS.
const SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
];

function sessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (SESSION_COOKIE_NAMES.includes(name)) {
      const value = part.slice(index + 1).trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * FNV-1a. This only has to spread session tokens across buckets — it is not a
 * security boundary — and middleware runs on the Edge runtime where
 * node:crypto is unavailable and Web Crypto is async.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Bucket key for a request.
 *
 * Keying on the client IP alone is unusable here: forwarded headers are
 * spoofable, so without a trusted proxy every caller collapsed onto a single
 * "direct" bucket and the whole deployment shared one 100-request minute.
 * A chatty terminal UI exhausts that in normal use by one person, which then
 * locks everybody — including sign-in — out. The session cookie is issued by
 * this app, is present on every authenticated request, and gives each browser
 * its own bucket. Unauthenticated callers still fall back to IP, and the
 * limiter's global ceiling bounds cookie rotation.
 */
export function clientIdentifierFromRequest(request: Request): string {
  const session = sessionCookie(request);
  if (session) {
    return `s:${shortHash(session)}`;
  }
  return `ip:${clientIpFromRequest(request)}`;
}

type SecurityRateLimiterOptions = {
  perIpWindowMs: number;
  perIpBurst: number;
  perIpLockoutMs: number;
  globalWindowMs: number;
  globalBurst: number;
};

type FailureWindow = { failures: number; resetAt: number; lockedUntil: number };

export function createRateLimiter(options: SecurityRateLimiterOptions) {
  const failures = new Map<string, FailureWindow>();
  let globalCount = 0;
  let globalResetAt = Date.now() + options.globalWindowMs;

  function cleanup(now: number) {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= now && entry.lockedUntil <= now) {
        failures.delete(key);
      }
    }
  }

  return {
    check(identifier: string): { ok: boolean; retryAfterSec: number } {
      const now = Date.now();
      cleanup(now);
      if (globalResetAt <= now) {
        globalCount = 0;
        globalResetAt = now + options.globalWindowMs;
      }
      if (globalCount >= options.globalBurst) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((globalResetAt - now) / 1000)) };
      }
      globalCount += 1;
      const entry = failures.get(identifier);
      if (entry && entry.lockedUntil > now) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
        };
      }
      return { ok: true, retryAfterSec: 0 };
    },
    record(identifier: string, success: boolean) {
      if (success) {
        failures.delete(identifier);
        return;
      }
      const now = Date.now();
      const current = failures.get(identifier);
      const entry =
        !current || current.resetAt <= now
          ? { failures: 0, resetAt: now + options.perIpWindowMs, lockedUntil: 0 }
          : current;
      entry.failures += 1;
      if (entry.failures >= options.perIpBurst) {
        entry.lockedUntil = now + options.perIpLockoutMs;
      }
      failures.set(identifier, entry);
    },
  };
}

// Per-identity ceilings. The API limit is deliberately generous: the terminal
// UI issues many small calls per interaction (project/tab reads, power lease
// renewals, preference writes), and a limit tuned for a REST API silently
// breaks the app rather than stopping abuse. The second argument to each
// limiter is the window; the third is the all-identities ceiling.
const apiLimiter = new RateLimiter(600, 60000, 20_000);
const authLimiter = new RateLimiter(10, 60000, 200);
const sensitiveLimiter = new RateLimiter(30, 60000, 1_000);

function getClientIdentifier(request: Request): string {
  return clientIdentifierFromRequest(request);
}

export function rateLimit(limiter: RateLimiter = apiLimiter) {
  return async (request: Request): Promise<NextResponse | null> => {
    const identifier = getClientIdentifier(request);
    const result = limiter.check(identifier);

    if (!result.allowed) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limiter.limit.toString(),
            "X-RateLimit-Remaining": result.remaining.toString(),
            "X-RateLimit-Reset": new Date(result.resetTime).toISOString(),
            "Retry-After": Math.ceil((result.resetTime - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    return null; // Allow request to proceed
  };
}

export function rateLimitByAuth(limiter: RateLimiter = authLimiter) {
  return async (request: Request, userId?: string): Promise<NextResponse | null> => {
    const identifier = userId || getClientIdentifier(request);
    const result = limiter.check(identifier);

    if (!result.allowed) {
      return NextResponse.json(
        {
          error: "Too many authentication attempts",
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limiter.limit.toString(),
            "X-RateLimit-Remaining": result.remaining.toString(),
            "X-RateLimit-Reset": new Date(result.resetTime).toISOString(),
            "Retry-After": Math.ceil((result.resetTime - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    return null;
  };
}

export function rateLimitSensitive(limiter: RateLimiter = sensitiveLimiter) {
  return async (request: Request): Promise<NextResponse | null> => {
    const identifier = getClientIdentifier(request);
    const result = limiter.check(identifier);

    if (!result.allowed) {
      return NextResponse.json(
        {
          error: "Too many sensitive operations",
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limiter.limit.toString(),
            "X-RateLimit-Remaining": result.remaining.toString(),
            "X-RateLimit-Reset": new Date(result.resetTime).toISOString(),
            "Retry-After": Math.ceil((result.resetTime - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    return null;
  };
}

export { apiLimiter, authLimiter, sensitiveLimiter };
