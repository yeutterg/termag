import { cookies } from "next/headers";

const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER_NAME = "x-csrf-token";

// Generate a random CSRF token
export function generateCSRFToken(): string {
  const bytes = new Uint8Array(CSRF_TOKEN_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Validate CSRF token from request
export async function validateCSRFToken(request: Request): Promise<boolean> {
  // Skip CSRF validation for GET requests as they are read-only
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return true;
  }

  // Browser fetches issued by this app carry an Origin header. A strict
  // origin/host match is sufficient CSRF protection and keeps every existing
  // same-origin mutation working without distributing a readable token.
  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      // Fall through to the double-submit token check.
    }
  }

  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE_NAME)?.value;
  const headerToken = request.headers.get(CSRF_HEADER_NAME);

  // For same-origin requests, check both cookie and header
  if (!cookieToken || !headerToken) {
    return false;
  }

  // Compare every code unit so a mismatch does not return early. Avoids the
  // Node-only crypto/Buffer APIs because middleware runs in the Edge runtime.
  if (cookieToken.length !== headerToken.length) return false;
  let difference = 0;
  for (let index = 0; index < cookieToken.length; index += 1) {
    difference |= cookieToken.charCodeAt(index) ^ headerToken.charCodeAt(index);
  }
  return difference === 0;
}

// Set CSRF token in cookie
export async function setCSRFCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24, // 24 hours
  });
}

// Get CSRF token from cookie
export async function getCSRFToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(CSRF_COOKIE_NAME)?.value;
}

// Generate and set CSRF token (for use in API routes)
export async function initializeCSRF(): Promise<string> {
  const token = generateCSRFToken();
  await setCSRFCookie(token);
  return token;
}

// Middleware to protect API routes from CSRF attacks
export async function csrfProtection(request: Request): Promise<Response | null> {
  if (!(await validateCSRFToken(request))) {
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
  let token = await getCSRFToken();

  if (!token) {
    token = await initializeCSRF();
  }

  return { token };
}
