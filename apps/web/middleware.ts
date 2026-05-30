import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { csrfProtection } from "@/lib/csrf";

// Runs ahead of every route handler. Two jobs:
//
//   1. Reject oversize request bodies before Next.js buffers them. Without
//      this, an attacker can POST a 10 GB body to any endpoint; route
//      handlers call request.json() which has no built-in cap. We check
//      Content-Length only here — full streaming inspection would require
//      reading the body, which is route-handler territory.
//
//   2. Add baseline security headers to every response: CSP, HSTS, COOP,
//      Referrer-Policy, X-Content-Type-Options, frame-ancestors, etc. The
//      terminal renderer ingests untrusted bytes; a strict CSP keeps any
//      future xterm/React injection bug from becoming arbitrary code.
//
//   3. Apply rate limiting to API endpoints to prevent abuse.
//
//   4. Apply CSRF protection to state-changing API endpoints.
//
// Tightened in dev: HSTS is off (no HTTPS), and connect-src includes ws:
// for the local broker. Production also adds upgrade-insecure-requests.

const BODY_CAP_BYTES = 256 * 1024;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_EXEMPT_PATHS = new Set(["/api/csrf", "/api/auth", "/api/health"]);

function buildCsp(): string {
  // 'self' covers same-origin assets. 'unsafe-inline' on style-src is the
  // standard concession for utility-CSS frameworks (Tailwind extracts and
  // injects styles at runtime in dev). Production builds can tighten with
  // hashes once a CSP-aware build pipeline is added.
  const isProd = process.env.NODE_ENV === "production";
  const styleSrc = isProd ? "'self' 'unsafe-inline'" : "'self' 'unsafe-inline'";
  // Next injects bootstrap/RSC scripts unless the app is wired for CSP
  // nonces. Keep inline scripts enabled in prod until that pipeline exists;
  // otherwise the built app renders but cannot hydrate.
  const scriptSrc = isProd ? "'self' 'unsafe-inline'" : "'self' 'unsafe-eval' 'unsafe-inline'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    isProd ? "upgrade-insecure-requests" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("Content-Security-Policy", buildCsp());
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // X-Frame-Options is redundant with frame-ancestors 'none' but adds
  // defense against ancient browsers.
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  // Apply rate limiting to API routes
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const rateLimitResult = rateLimit()(request);
    if (rateLimitResult) {
      return rateLimitResult;
    }
  }

  // Apply CSRF protection to state-changing API endpoints
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method) &&
    !CSRF_EXEMPT_PATHS.has(request.nextUrl.pathname)
  ) {
    const csrfResult = csrfProtection(request);
    if (csrfResult) {
      return csrfResult as NextResponse;
    }
  }

  // Reject oversize bodies on mutating requests via declared Content-Length.
  // A client that lies about Content-Length (HTTP/1.1 chunked transfer) can
  // still slip past — route handlers should still validate untrusted data
  // bounded by their schema. This catches the common case cheaply.
  if (MUTATING_METHODS.has(request.method)) {
    const declared = request.headers.get("content-length");
    if (declared) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > BODY_CAP_BYTES) {
        return applySecurityHeaders(
          NextResponse.json({ error: "Request body too large" }, { status: 413 })
        );
      }
    }
  }
  return applySecurityHeaders(NextResponse.next());
}

// Run on everything except Next.js internals + static files. The matcher
// excludes the WS upgrade path because middleware doesn't see it (the
// upgrade is intercepted by server.js before Next gets the request).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
