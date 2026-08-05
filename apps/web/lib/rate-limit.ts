import { NextResponse } from "next/server";

// Simple in-memory rate limiter for development
// In production, consider using Redis-backed rate limiting
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

class RateLimiter {
  private requests: Map<string, RateLimitEntry> = new Map();

  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 60000
  ) {}

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.requests.entries()) {
      if (entry.resetTime <= now) {
        this.requests.delete(key);
      }
    }
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
    this.cleanup();
    const now = Date.now();
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
  }
}

export function clientIpFromRequest(request: Request): string {
  // Forwarded IP headers are attacker-controlled unless the deployment has
  // explicitly declared its reverse proxy trusted. The conservative direct
  // fallback shares one bucket, which is safer than a spoofable per-IP key.
  if (process.env.TERMAG_TRUSTED_PROXY !== "true") {
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

// Rate limiters for different endpoints
const apiLimiter = new RateLimiter(100, 60000); // 100 requests per minute
const authLimiter = new RateLimiter(5, 60000); // 5 requests per minute for auth
const sensitiveLimiter = new RateLimiter(10, 60000); // 10 requests per minute for sensitive operations

function getClientIdentifier(request: Request): string {
  return clientIpFromRequest(request);
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
            "X-RateLimit-Limit": limiter["maxRequests"].toString(),
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
            "X-RateLimit-Limit": limiter["maxRequests"].toString(),
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
            "X-RateLimit-Limit": limiter["maxRequests"].toString(),
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
