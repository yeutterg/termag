import { cookies } from "next/headers";
import crypto from "node:crypto";

const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER_NAME = "x-csrf-token";

// Generate a random CSRF token
export function generateCSRFToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
}

// Validate CSRF token from request
export function validateCSRFToken(request: Request): boolean {
  // Skip CSRF validation for GET requests as they are read-only
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return true;
  }

  const cookieStore = cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE_NAME)?.value;
  const headerToken = request.headers.get(CSRF_HEADER_NAME);

  // For same-origin requests, check both cookie and header
  if (!cookieToken || !headerToken) {
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(cookieToken, "hex"), Buffer.from(headerToken, "hex"));
}

// Set CSRF token in cookie
export function setCSRFCookie(token: string): void {
  const cookieStore = cookies();
  cookieStore.set(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24, // 24 hours
  });
}

// Get CSRF token from cookie
export function getCSRFToken(): string | undefined {
  const cookieStore = cookies();
  return cookieStore.get(CSRF_COOKIE_NAME)?.value;
}

// Generate and set CSRF token (for use in API routes)
export function initializeCSRF(): string {
  const token = generateCSRFToken();
  setCSRFCookie(token);
  return token;
}

// Middleware to protect API routes from CSRF attacks
export function csrfProtection(request: Request): Response | null {
  if (!validateCSRFToken(request)) {
    return new Response(
      JSON.stringify({
        error: "CSRF token validation failed",
        message: "Invalid or missing CSRF token",
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
  return null;
}

// Generate CSRF token for client-side use
export async function getCSRFTokenForClient(): Promise<{ token: string }> {
  let token = getCSRFToken();

  if (!token) {
    token = initializeCSRF();
  }

  return { token };
}
