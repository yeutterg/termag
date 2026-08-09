import { NextResponse } from "next/server";

// Unauthenticated marker endpoint: lets the CLI confirm it's talking to a
// Terminalz broker before sending an agent token. Used by the localhost
// CLI clients can probe this before an automatic fallback so a Bearer token never gets
// POSTed to an unrelated dev server that happens to share a port.
//
// Returns a tiny static payload — no DB access, no auth — so an attacker
// can't use the endpoint to enumerate state, and it's safe to spam.

export const dynamic = "force-static";
export const revalidate = false;

export function GET() {
  return NextResponse.json({ service: "terminalz", api: "cli" });
}

export function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "x-terminalz-service": "broker",
      "x-termag-service": "broker",
    },
  });
}
