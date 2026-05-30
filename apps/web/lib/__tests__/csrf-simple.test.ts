// Test CSRF token generation in isolation
import nodeCrypto from "node:crypto";

const CSRF_TOKEN_LENGTH = 32;

function generateCSRFToken(): string {
  return nodeCrypto.randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
}

describe("CSRF Token Generation", () => {
  it("should generate a token of correct length", () => {
    const token = generateCSRFToken();
    expect(token).toHaveLength(64); // 32 bytes = 64 hex characters
  });

  it("should generate different tokens each time", () => {
    const token1 = generateCSRFToken();
    const token2 = generateCSRFToken();
    expect(token1).not.toBe(token2);
  });

  it("should generate valid hex string", () => {
    const token = generateCSRFToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should generate tokens with sufficient entropy", () => {
    // Generate many tokens and check for uniqueness
    const tokens = new Set();
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateCSRFToken());
    }
    // All 1000 tokens should be unique
    expect(tokens.size).toBe(1000);
  });
});
