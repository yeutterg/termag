import { NextResponse } from "next/server";

// Simple in-memory rate limiter for development
// In production, consider using Redis-backed rate limiting
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

class RateLimiter {
  private requests: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 60000
  ) {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.requests.entries()) {
      if (entry.resetTime <= now) {
        this.requests.delete(key);
      }
    }
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.requests.clear();
  }
}

// Rate limiters for different endpoints
const apiLimiter = new RateLimiter(100, 60000); // 100 requests per minute
const authLimiter = new RateLimiter(5, 60000); // 5 requests per minute for auth
const sensitiveLimiter = new RateLimiter(10, 60000); // 10 requests per minute for sensitive operations

function getClientIdentifier(request: Request): string {
  // Try to get client IP from various headers
  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const cfConnectingIp = request.headers.get("cf-connecting-ip");

  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  if (realIp) {
    return realIp;
  }
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  // Fallback to a combination of headers
  return request.headers.get("user-agent") || "unknown";
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
