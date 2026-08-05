import {
  rateLimit,
  apiLimiter,
  authLimiter,
  sensitiveLimiter,
  clientIpFromRequest,
  createRateLimiter,
} from "../rate-limit";

describe("Rate Limiting", () => {
  describe("rateLimit function", () => {
    it("should return null for allowed requests", async () => {
      const request = new Request("http://localhost:3000/api/test");
      const result = await rateLimit(apiLimiter)(request);
      expect(result).toBeNull();
    });

    it("should return response for rate-limited requests", async () => {
      // Make many requests to hit the limit
      const request = new Request("http://localhost:3000/api/test");

      // Use up the limit (100 requests)
      for (let i = 0; i < 100; i++) {
        await rateLimit(apiLimiter)(request);
      }

      // Next request should be rate limited
      const result = await rateLimit(apiLimiter)(request);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.status).toBe(429);
      }
    });
  });

  describe("different limiters", () => {
    it("should have different limits for different limiter types", () => {
      // The limiters should have different max request counts
      expect(apiLimiter["maxRequests"]).toBe(100);
      expect(authLimiter["maxRequests"]).toBe(5);
      expect(sensitiveLimiter["maxRequests"]).toBe(10);
    });
  });

  describe("security limiter", () => {
    it("locks repeated failures without allocating cleanup intervals", () => {
      jest.useFakeTimers();
      const limiter = createRateLimiter({
        perIpWindowMs: 10_000,
        perIpBurst: 2,
        perIpLockoutMs: 1_000,
        globalWindowMs: 10_000,
        globalBurst: 20,
      });
      expect(limiter.check("client").ok).toBe(true);
      limiter.record("client", false);
      expect(limiter.check("client").ok).toBe(true);
      limiter.record("client", false);
      expect(limiter.check("client")).toMatchObject({ ok: false, retryAfterSec: 1 });
      jest.advanceTimersByTime(1_001);
      expect(limiter.check("client").ok).toBe(true);
      jest.useRealTimers();
    });

    it("uses forwarded addresses only behind an explicitly trusted proxy", () => {
      const previous = process.env.TERMAG_TRUSTED_PROXY;
      const request = new Request("http://localhost", {
        headers: { "x-forwarded-for": "203.0.113.5, 127.0.0.1" },
      });
      delete process.env.TERMAG_TRUSTED_PROXY;
      expect(clientIpFromRequest(request)).toBe("direct");
      process.env.TERMAG_TRUSTED_PROXY = "true";
      expect(clientIpFromRequest(request)).toBe("203.0.113.5");
      if (previous === undefined) {
        delete process.env.TERMAG_TRUSTED_PROXY;
      } else {
        process.env.TERMAG_TRUSTED_PROXY = previous;
      }
    });
  });
});
