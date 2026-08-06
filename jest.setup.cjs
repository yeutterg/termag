// Mock environment variables
process.env.DATABASE_URL = "file:./test.db";
process.env.NEXTAUTH_URL = "http://localhost:3000";
process.env.NEXTAUTH_SECRET = "test-secret-for-jest";
process.env.TERMINALZ_TRUSTED_NETWORK = "true";

// Suppress console errors in tests unless debugging
const originalError = console.error;
console.error = (...args) => {
  if (
    typeof args[0] === "string" &&
    (args[0].includes("Warning:") ||
      args[0].includes("Not implemented:") ||
      args[0].includes("Deprecated:"))
  ) {
    return;
  }
  originalError.call(console, ...args);
};
