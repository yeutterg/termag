import { rateLimit, apiLimiter, authLimiter, sensitiveLimiter } from "../rate-limit";

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
});
