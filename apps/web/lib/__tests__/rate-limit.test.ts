import {
  rateLimit,
  apiLimiter,
  authLimiter,
  sensitiveLimiter,
  clientIpFromRequest,
  clientIdentifierFromRequest,
  createRateLimiter,
} from "../rate-limit";

function sessionRequest(token: string): Request {
  return new Request("http://localhost:3000/api/test", {
    headers: { cookie: `theme=dark; authjs.session-token=${token}` },
  });
}

describe("Rate Limiting", () => {
  describe("rateLimit function", () => {
    it("should return null for allowed requests", async () => {
      const request = new Request("http://localhost:3000/api/test");
      const result = await rateLimit(apiLimiter)(request);
      expect(result).toBeNull();
    });

    it("should return response for rate-limited requests", async () => {
      const request = sessionRequest("exhaust-me");

      for (let i = 0; i < apiLimiter.limit; i++) {
        await rateLimit(apiLimiter)(request);
      }

      const result = await rateLimit(apiLimiter)(request);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.status).toBe(429);
      }
    });

    it("does not let one exhausted browser lock out another", async () => {
      // The previous shared-bucket default meant a single active user could
      // 429 the whole deployment, sign-in included.
      const heavy = sessionRequest("heavy-user");
      for (let i = 0; i < apiLimiter.limit + 5; i++) {
        await rateLimit(apiLimiter)(heavy);
      }
      expect(await rateLimit(apiLimiter)(heavy)).not.toBeNull();
      expect(await rateLimit(apiLimiter)(sessionRequest("quiet-user"))).toBeNull();
    });
  });

  describe("client identity", () => {
    it("buckets per session cookie and falls back to ip", () => {
      expect(clientIdentifierFromRequest(sessionRequest("a"))).not.toBe(
        clientIdentifierFromRequest(sessionRequest("b"))
      );
      expect(clientIdentifierFromRequest(sessionRequest("a"))).toBe(
        clientIdentifierFromRequest(sessionRequest("a"))
      );
      expect(clientIdentifierFromRequest(new Request("http://localhost:3000/api/test"))).toBe(
        "ip:direct"
      );
    });

    it("recognises each Auth.js session cookie spelling", () => {
      for (const name of [
        "authjs.session-token",
        "__Secure-authjs.session-token",
        "next-auth.session-token",
        "__Secure-next-auth.session-token",
      ]) {
        const request = new Request("http://localhost:3000/api/test", {
          headers: { cookie: `${name}=token-value` },
        });
        expect(clientIdentifierFromRequest(request)).toMatch(/^s:/);
      }
    });
  });

  describe("different limiters", () => {
    it("should have different limits for different limiter types", () => {
      expect(apiLimiter.limit).toBe(600);
      expect(authLimiter.limit).toBe(10);
      expect(sensitiveLimiter.limit).toBe(30);
    });

    it("still bounds total load when identities rotate", async () => {
      const limiter = new (Object.getPrototypeOf(apiLimiter).constructor)(5, 60_000, 12);
      for (let i = 0; i < 12; i++) {
        expect(limiter.check(`rotating-${i}`).allowed).toBe(true);
      }
      expect(limiter.check("rotating-13").allowed).toBe(false);
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
      const previous = process.env.TERMINALZ_TRUSTED_PROXY;
      const request = new Request("http://localhost", {
        headers: { "x-forwarded-for": "203.0.113.5, 127.0.0.1" },
      });
      delete process.env.TERMINALZ_TRUSTED_PROXY;
      expect(clientIpFromRequest(request)).toBe("direct");
      process.env.TERMINALZ_TRUSTED_PROXY = "true";
      expect(clientIpFromRequest(request)).toBe("203.0.113.5");
      if (previous === undefined) {
        delete process.env.TERMINALZ_TRUSTED_PROXY;
      } else {
        process.env.TERMINALZ_TRUSTED_PROXY = previous;
      }
    });
  });
});
