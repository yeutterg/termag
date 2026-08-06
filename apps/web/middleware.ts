import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

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
//   4. Reject cross-origin browser mutations.
//
// Tightened in dev: HSTS is off (no HTTPS), and connect-src includes ws:
// for the local broker. Production also adds upgrade-insecure-requests.

const BODY_CAP_BYTES = 256 * 1024;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Auth.js validates its own callback state. Bootstrap claims use the
// short-lived, one-use URL code as their credential and are called by the CLI.
const CSRF_EXEMPT_PREFIXES = ["/api/auth", "/api/bootstrap/claim"];

function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function isSameOriginMutation(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser clients do not send Origin. Browser cross-site mutations are
    // caught by Origin and/or Sec-Fetch-Site without a readable token cookie.
    return true;
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  try {
    return Boolean(host && new URL(origin).host === host);
  } catch {
    return false;
  }
}

function buildCsp(): string {
  // 'self' covers same-origin assets. 'unsafe-inline' on style-src is the
  // standard concession for utility-CSS frameworks (Tailwind extracts and
  // injects styles at runtime in dev). Production builds can tighten with
  // hashes once a CSP-aware build pipeline is added.
  const isProd = process.env.NODE_ENV === "production";
  const styleSrc = "'self' 'unsafe-inline'";
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
    // 'self' covers the broker's ws:/wss: upgrade on the same origin. The
    // previous bare "ws: wss:" allowed a socket to *any* host, which is a
    // ready-made exfil channel for a renderer whose whole job is to display
    // untrusted bytes. TERMINALZ_BROKER_ORIGIN opts a split deployment back in.
    `connect-src ${["'self'", process.env.TERMINALZ_BROKER_ORIGIN].filter(Boolean).join(" ")}`,
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

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Apply rate limiting to API routes
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const rateLimitResult = await rateLimit()(request);
    if (rateLimitResult) {
      // Early returns get the same headers as every other response; a 429
      // without a CSP is still a response an attacker can try to work with.
      return applySecurityHeaders(rateLimitResult);
    }
  }

  // Same-origin checks are sufficient for cookie-authenticated browser APIs;
  // a second readable cookie/header token added state without adding trust.
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method) &&
    !isCsrfExempt(request.nextUrl.pathname)
  ) {
    if (!isSameOriginMutation(request)) {
      return applySecurityHeaders(
        NextResponse.json({ error: "Cross-origin mutation rejected" }, { status: 403 })
      );
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
